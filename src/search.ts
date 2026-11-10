import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Sharing } from "@sigrun/shared/access";
import type { SessionMeta } from "@sigrun/shared/session-meta";

import type { ArtifactStore } from "./artifacts.js";
import { audienceCovers } from "./audience.js";
import type { UserRecallSettings } from "./settings-schema.js";
import type { ItemKind, ItemRow, RecallDb } from "./db.js";
import { passagesOf } from "./passages.js";
import { mayRead } from "./policy.js";
import { redact } from "./redact.js";
import { snippetOf } from "./snippet.js";

const ARM_LIMIT = 200;
const RRF_K = 60;
const DAY_MS = 86_400_000;

export interface SearchContext {
	current: { conversationId: number | undefined; owner?: string; sharing?: Sharing };
	model: { provider: string } | undefined;
	excludeConversation?: number;
	includeJobs: boolean;
	/** Inclusive message-time lower bound. */
	since?: number;
	/** Exclusive message-time upper bound. */
	until?: number;
	kinds?: readonly ItemKind[];
}

export interface Hit {
	item: ItemRow;
	score: number;
	snippet: string;
	handle: string;
	conversationTitle: string | null;
}

export interface Searcher {
	search(query: string, ctx: SearchContext, limit: number): Promise<Hit[]>;
}

export interface VectorArm {
	query(text: string, candidateLimit: number): Promise<{ itemId: number; rank: number }[]>;
}

export function createSearcher(deps: {
	db: RecallDb;
	meta(id: number): Promise<SessionMeta>;
	entry(conversationId: number, entryId: number): Promise<EntryRecord | undefined>;
	userSettings(user: string): Promise<UserRecallSettings>;
	vectors?: VectorArm;
	artifactStore?: ArtifactStore;
	now(): number;
}): Searcher {
	return {
		async search(query, ctx, limit) {
			if (limit <= 0) return [];
			const tokens = query.split(/\s+/).filter((token) => token.length >= 2);
			const porterQuery = tokens.map(quote).join(" ");
			const trigramQuery = tokens
				.filter((token) => token.length >= 3)
				.map(quote)
				.join(" ");
			const ranks = new Map<number, { item: ItemRow; score: number }>();

			function fuse(rows: { id: number }[]): void {
				for (const [index, row] of rows.entries()) {
					const item = deps.db.item(row.id);
					if (item === undefined) continue;
					const existing = ranks.get(row.id);
					const score = 1 / (RRF_K + index + 1);
					if (existing === undefined) ranks.set(row.id, { item, score });
					else existing.score += score;
				}
			}

			if (porterQuery !== "") fuse(deps.db.searchPorter(porterQuery, ARM_LIMIT));
			if (trigramQuery !== "") fuse(deps.db.searchTrigram(trigramQuery, ARM_LIMIT));
			if (deps.vectors !== undefined) {
				const vectors = await deps.vectors.query(query, ARM_LIMIT);
				fuse(vectors.map(({ itemId }) => ({ id: itemId })));
			}

			const candidates = [...ranks.values()]
				.map((candidate) => ({
					...candidate,
					score: candidate.score * recency(candidate.item.at, deps.now()),
				}))
				.sort((a, b) => b.score - a.score);
			const metas = new Map<number, Promise<SessionMeta | undefined>>();
			const settings = new Map<string, Promise<readonly string[]>>();
			const entries = new Map<string, Promise<EntryRecord | undefined>>();
			const hits: Hit[] = [];

			for (const candidate of candidates) {
				if (hits.length >= limit) break;
				const item = candidate.item;
				if (
					item.conversationId === ctx.excludeConversation ||
					(item.job && !ctx.includeJobs) ||
					(ctx.kinds !== undefined && !ctx.kinds.includes(item.kind)) ||
					(ctx.since !== undefined && item.at < ctx.since) ||
					(ctx.until !== undefined && item.at >= ctx.until)
				) {
					continue;
				}

				let metaPromise: Promise<SessionMeta | undefined> | undefined;
				if (item.conversationId !== null) {
					metaPromise = metas.get(item.conversationId);
					if (metaPromise === undefined) {
						metaPromise = deps.meta(item.conversationId).catch(() => undefined);
						metas.set(item.conversationId, metaPromise);
					}
				} else if (item.owner !== null) {
					// User-owned documents have no conversation; the owner is the audience.
					metaPromise = Promise.resolve({
						pinned: false,
						tagged: [],
						archived: false,
						draft: { text: "", attachments: [] },
						source: "doc",
						owner: item.owner,
					});
				}
				const meta = metaPromise === undefined ? undefined : await metaPromise;
				if (
					meta === undefined ||
					meta.internal === true ||
					meta.deleted === true ||
					!audienceCovers(ctx.current, meta)
				) {
					continue;
				}

				let localProviders: readonly string[] = [];
				if (item.owner !== null) {
					let settingsPromise = settings.get(item.owner);
					if (settingsPromise === undefined) {
						settingsPromise = deps
							.userSettings(item.owner)
							.then((value) => value.localProviders)
							.catch(() => []);
						settings.set(item.owner, settingsPromise);
					}
					localProviders = await settingsPromise;
				}
				if (!mayRead(item.cls, ctx.model, localProviders)) continue;

				const source = await sourceText(deps, item, entries);
				if (source === undefined) continue;
				const docRow = item.doc === null ? undefined : deps.db.doc(item.doc);
				hits.push({
					item,
					score: candidate.score,
					snippet: snippetOf(redact(source), tokens),
					handle:
						item.kind === "artifact"
							? item.artifact!
							: item.kind === "doc"
								? `d:${item.doc}`
								: `r:${item.id}`,
					conversationTitle:
						docRow === undefined
							? (meta.name ?? meta.autoName ?? null)
							: docRow.title,
				});
			}
			return hits;
		},
	};
}

function quote(token: string): string {
	return `"${token.replaceAll('"', '""')}"`;
}

function recency(at: number, now: number): number {
	const ageDays = Math.max(0, (now - at) / DAY_MS);
	return 0.8 + 0.2 * Math.exp(-ageDays / 180);
}

async function sourceText(
	deps: Parameters<typeof createSearcher>[0],
	item: ItemRow,
	entries: Map<string, Promise<EntryRecord | undefined>>,
): Promise<string | undefined> {
	if (item.kind === "artifact") {
		// Artifact snippets read the stored whole text (Task 5's store);
		// recall_open reuses the same read.
		return item.artifact === null
			? undefined
			: deps.artifactStore?.read(item.artifact, item.offset, item.length);
	}
	if (item.kind === "doc") {
		return item.doc === null
			? undefined
			: deps.db.docText(item.doc, item.offset, item.length);
	}
	if (item.entryId === null || item.messageIndex === null) return undefined;
	const key = `${item.conversationId}:${item.entryId}`;
	let entryPromise = entries.get(key);
	if (entryPromise === undefined) {
		const conversationId = item.conversationId;
		const entryId = item.entryId;
		if (conversationId === null) return undefined;
		entryPromise = deps.entry(conversationId, entryId);
		entries.set(key, entryPromise);
	}
	const entry = await entryPromise;
	if (entry === undefined) return undefined;
	const passage = passagesOf(entry).find(
		(candidate) =>
			candidate.messageIndex === item.messageIndex &&
			candidate.blockIndex === item.blockIndex &&
			candidate.offset === item.offset,
	);
	return passage?.text;
}
