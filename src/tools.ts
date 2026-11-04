import { Type } from "@earendil-works/pi-ai";
import type {
	Cursor,
	EntryRecord,
	Page,
	ToolExecutionResult,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import { defineTool } from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/session-meta";

import type { ArtifactStore } from "./artifacts.js";
import { audienceCovers } from "./audience.js";
import type { ItemRow, RecallDb } from "./db.js";
import { mayRead } from "./policy.js";
import { redact } from "./redact.js";
import type { Hit, Searcher } from "./search.js";

const OPEN_LIMIT = 16_384;

export interface ToolsDeps {
	db: RecallDb;
	searcher: Searcher;
	artifactStore: ArtifactStore;
	meta(id: number): Promise<SessionMeta>;
	entries(
		conversationId: number,
		query: { minEntryId?: number; maxEntryId?: number; order: "ascending" },
		limit: number,
		cursor?: Cursor,
	): Promise<Page<EntryRecord, Cursor>>;
	localProviders(user: string): Promise<readonly string[]>;
}

function output(text: string): ToolExecutionResult {
	return { output: [{ type: "text", text }] };
}

function date(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function taint(db: RecallDb, conversationId: number, item: ItemRow): void {
	if (item.cls === "local-only") {
		db.setTaint(conversationId, (db.cursor(conversationId) ?? 0) + 1);
	}
}

async function permitted(
	deps: ToolsDeps,
	current: SessionMeta,
	item: ItemRow,
	provider: string | undefined,
): Promise<SessionMeta | undefined> {
	if (!audienceCovers(current, { owner: item.owner ?? undefined })) return undefined;
	// User-owned documents have no conversation; the owner is the audience.
	const meta =
		item.conversationId === null
			? item.owner === null
				? undefined
				: ({
						pinned: false,
						tagged: [],
						archived: false,
						draft: { text: "", attachments: [] },
						source: "doc",
						owner: item.owner,
					} satisfies SessionMeta)
			: await deps.meta(item.conversationId).catch(() => undefined);
	if (meta === undefined || meta.internal === true || !audienceCovers(current, meta)) {
		return undefined;
	}
	const providers = item.owner === null ? [] : await deps.localProviders(item.owner).catch(() => []);
	if (!mayRead(item.cls, provider === undefined ? undefined : { provider }, providers)) {
		return undefined;
	}
	return meta;
}

function renderEntries(entries: readonly EntryRecord[]): string {
	const lines: string[] = [];
	for (const entry of entries) {
		for (const message of entry.model ?? []) {
			if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
				continue;
			}
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n");
			if (text !== "") lines.push(`${message.role}: ${redact(text)}`);
		}
	}
	let bytes = 0;
	const bounded: string[] = [];
	for (const line of lines) {
		// Count the "\n" join separator per emitted line against the cap.
		if (bytes >= OPEN_LIMIT) break;
		const remaining = OPEN_LIMIT - bytes;
		const buffer = Buffer.from(line, "utf8");
		let end = Math.min(buffer.length, remaining);
		while (end > 0 && end < buffer.length && (buffer[end]! & 0xc0) === 0x80) end -= 1;
		bounded.push(buffer.subarray(0, end).toString("utf8"));
		bytes += end + 1;
	}
	return bounded.join("\n");
}

/** Build the read-only model-facing recall tools. */
export function createTools(deps: ToolsDeps): readonly ToolRegistration[] {
	const search = defineTool({
		name: "recall_search",
		description: "Search past conversations and stored tool results for relevant material.",
		parameters: Type.Object({
			query: Type.String(),
			since: Type.Optional(Type.String()),
			until: Type.Optional(Type.String()),
			kind: Type.Optional(Type.Union([Type.Literal("conversation"), Type.Literal("page")])),
			conversation: Type.Optional(Type.Number()),
		}),
		replay: "safe",
		async execute(args, api, context) {
			const conversationId = Number(api.conversationId);
			const current = await deps.meta(conversationId);
			const model = (await api.agent(context)).model;
			const kinds =
				args.kind === "conversation"
					? (["turn", "tool"] as const)
					: args.kind === "page"
						? (["artifact"] as const)
						: undefined;
			const hits = await deps.searcher.search(
				args.query,
				{
					current: {
						conversationId,
						owner: current.owner,
						sharing: current.sharing,
					},
					model: model === undefined ? undefined : { provider: model.provider },
					includeJobs: true,
					since: date(args.since),
					until: date(args.until),
					kinds,
				},
				args.conversation === undefined ? 10 : 200,
			);
			const selected = hits
				.filter((hit) => args.conversation === undefined || hit.item.conversationId === args.conversation)
				.slice(0, 10);
			for (const hit of selected) taint(deps.db, conversationId, hit.item);
			if (selected.length === 0) return output("No matching past material.");

			// Stable score order within first-seen conversation groups.
			const groups = new Map<number, Hit[]>();
			for (const hit of selected) {
				const conversation = hit.item.conversationId ?? 0;
				const group = groups.get(conversation) ?? [];
				group.push(hit);
				groups.set(conversation, group);
			}
			const lines = [...groups.values()].flatMap((group) =>
				group.map((hit) => {
					const day = new Date(hit.item.at).toISOString().slice(0, 10);
					const title = hit.conversationTitle ?? `conversation ${hit.item.conversationId}`;
					return `[${day}] ${title} — ${hit.snippet} (${hit.handle})`;
				}),
			);
			return output(lines.join("\n"));
		},
	});

	const open = defineTool({
		name: "recall_open",
		description: "Open a recalled passage or read a slice of a stored artifact.",
		parameters: Type.Object({
			handle: Type.String(),
			offset: Type.Optional(Type.Number()),
			length: Type.Optional(Type.Number({ maximum: OPEN_LIMIT })),
		}),
		replay: "safe",
		async execute(args, api, context) {
			const conversationId = Number(api.conversationId);
			const current = await deps.meta(conversationId);
			const model = (await api.agent(context)).model;
			const provider = model?.provider;
			const item = await itemForHandle(deps.db, args.handle);
			if (item === undefined || (await permitted(deps, current, item, provider)) === undefined) {
				return output("Not available here.");
			}
			taint(deps.db, conversationId, item);

			if (args.handle.startsWith("a:")) {
				const length = Math.min(args.length ?? OPEN_LIMIT, OPEN_LIMIT);
				const text = deps.artifactStore.read(args.handle, args.offset ?? 0, length);
				return text === undefined ? output("Not available here.") : output(text);
			}
			if (item.entryId === null || item.conversationId === null) {
				return output("Not available here.");
			}
			const source = item.conversationId;
			const page = await deps
				.entries(
				source,
				{
					minEntryId: Math.max(1, item.entryId - 3),
					maxEntryId: item.entryId + 3,
					order: "ascending",
				},
					10,
					undefined,
				)
				.catch(() => undefined);
			if (page === undefined) return output("Not available here.");
			const nearby = deps.db.itemsForEntries(
				source,
				page.items.map((entry) => entry.id),
			);
			for (const candidate of nearby) {
				if ((await permitted(deps, current, candidate, provider)) === undefined) {
					return output("Not available here.");
				}
			}
			for (const candidate of nearby) taint(deps.db, conversationId, candidate);
			const text = renderEntries(page.items);
			return output(text === "" ? "Not available here." : text);
		},
	});
	return [search, open];
}

async function itemForHandle(db: RecallDb, handle: string): Promise<ItemRow | undefined> {
	if (handle.startsWith("r:")) return db.item(Number(handle.slice(2)));
	if (handle.startsWith("a:")) return db.itemByArtifact(handle);
	return undefined;
}
