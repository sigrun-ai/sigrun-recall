import type { Cursor, EntryRecord, Page } from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/session-meta";

import type { RecallDb } from "./db.js";
import { passagesOf } from "./passages.js";
import { redact } from "./redact.js";
import type { EmbeddingHost, EmbeddingWarning } from "./vectors.js";
import { DEFAULT_EMBEDDING_WARNINGS, embedClass } from "./vectors.js";

const PAGE_SIZE = 200;

export interface CaptureDeps {
	db: RecallDb;
	meta(id: number): Promise<SessionMeta>;
	now(): number;
	/**
	 * Optional best-effort semantic indexing; capture never awaits
	 * embedding. No `model` is requested (the live `embeddingModel`
	 * default decides) and vectors are stored under the model the
	 * provider RETURNED, so a provider that resolves a different model
	 * still lands its vectors in the right space.
	 */
	embeddings?: EmbeddingHost;
	trackEmbedding?: (work: Promise<void>) => void;
	warn?: EmbeddingWarning;
}

export type EntryReader = (
	query: { minEntryId?: number; order: "ascending" },
	limit: number,
	cursor?: Cursor,
) => Promise<Page<EntryRecord, Cursor>>;

/** Index newly settled conversation entries, resuming from the saved cursor. */
export async function captureConversation(
	deps: CaptureDeps,
	conversationId: number,
	read: EntryReader,
): Promise<{ indexed: number }> {
	const meta = await deps.meta(conversationId);
	if (meta.internal === true) return { indexed: 0 };

	const savedCursor = deps.db.cursor(conversationId);
	const query: { minEntryId?: number; order: "ascending" } = { order: "ascending" };
	if (savedCursor !== undefined) query.minEntryId = savedCursor + 1;
	const taintFrom = deps.db.taintFrom(conversationId);
	let indexed = 0;
	let cursor: Cursor | undefined;

	do {
		const page = await read(query, PAGE_SIZE, cursor);
		const normal: { id: number; text: string }[] = [];
		const local: { id: number; text: string }[] = [];
		for (const entry of page.items) {
			if (entry.conversationId !== conversationId) continue;
			for (const passage of passagesOf(entry)) {
				const localOnly = taintFrom !== undefined && passage.entryId >= taintFrom;
				const inserted = deps.db.insertItem(
					{
						conversationId,
						owner: meta.owner ?? null,
						kind: passage.kind,
						entryId: passage.entryId,
						messageIndex: passage.messageIndex,
						blockIndex: passage.blockIndex,
						offset: passage.offset,
						length: passage.length,
						artifact: null,
						doc: null,
						job: meta.jobId !== undefined,
						cls: localOnly ? "local-only" : "normal",
						at: passage.at,
						title: meta.name ?? meta.autoName ?? null,
					},
					redact(passage.text),
				);
				if (inserted !== undefined) {
					indexed += 1;
					(localOnly ? local : normal).push({
						id: inserted,
						text: redact(passage.text),
					});
				}
			}
		}

		if (deps.embeddings !== undefined) {
			const work = embedPage(deps, normal, local);
			if (deps.trackEmbedding === undefined) void work;
			else deps.trackEmbedding(work);
		}

		const lastEntry = page.items.at(-1);
		if (lastEntry !== undefined) deps.db.setCursor(conversationId, lastEntry.id);
		cursor = page.next;
	} while (cursor !== undefined);

	return { indexed };
}

/**
 * TWO calls per page, one per confidentiality class — never mixed, so a
 * provider that refuses `local-only` cannot take the normal batch down with
 * it (and the normal batch is never labelled more strictly than it needs to
 * be). No `model` is requested: the live `embeddingModel` default decides.
 */
async function embedPage(
	deps: CaptureDeps,
	normal: readonly { id: number; text: string }[],
	local: readonly { id: number; text: string }[],
): Promise<void> {
	const embeddings = deps.embeddings;
	if (embeddings === undefined) return;
	const warn = deps.warn ?? DEFAULT_EMBEDDING_WARNINGS;
	const upsert = (itemId: number, model: string, vec: Float32Array) =>
		deps.db.upsertVector(itemId, model, vec);
	await embedClass(embeddings, upsert, normal, "normal", undefined, warn);
	await embedClass(embeddings, upsert, local, "local-only", undefined, warn);
}
