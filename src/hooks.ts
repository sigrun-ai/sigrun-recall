import { Type, type Static } from "@earendil-works/pi-ai";
import type { PublishedHook, PublishedHookCall } from "@sigrun/sigrun/extension";
import type { SessionMeta } from "@sigrun/shared/session-meta";

import type { Confidentiality, DocRow, ItemRow, RecallDb } from "./db.js";
import type { Searcher } from "./search.js";

export const RecallIndexInput = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 256 }),
	kind: Type.String({ minLength: 1, maxLength: 64 }),
	title: Type.String({ maxLength: 512 }),
	text: Type.String(),
	date: Type.String({ format: "date-time" }),
	url: Type.Optional(Type.String()),
	class: Type.Optional(
		Type.Union([Type.Literal("normal"), Type.Literal("local-only")]),
	),
	sources: Type.Optional(
		Type.Array(Type.String(), { maxItems: 100 }),
	),
});
export type RecallIndexInput = Static<typeof RecallIndexInput>;

export const RecallIndexOutput = Type.Object({
	handle: Type.String(),
	class: Type.Union([Type.Literal("normal"), Type.Literal("local-only")]),
	changed: Type.Boolean(),
});
export type RecallIndexOutput = Static<typeof RecallIndexOutput>;

export const RecallRemoveInput = Type.Object({
	id: Type.String({ minLength: 1, maxLength: 256 }),
});
export type RecallRemoveInput = Static<typeof RecallRemoveInput>;

export const RecallRemoveOutput = Type.Object({
	removed: Type.Boolean(),
});
export type RecallRemoveOutput = Static<typeof RecallRemoveOutput>;

export const RecallSearchInput = Type.Object({
	query: Type.String(),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
	kinds: Type.Optional(
		Type.Array(
			Type.Union([
				Type.Literal("turn"),
				Type.Literal("tool"),
				Type.Literal("artifact"),
				Type.Literal("doc"),
			]),
		),
	),
	model: Type.Optional(
		Type.Object({
			provider: Type.String(),
			modelId: Type.String(),
		}),
	),
});
export type RecallSearchInput = Static<typeof RecallSearchInput>;

export const RecallSearchOutput = Type.Object({
	hits: Type.Array(
		Type.Object({
			handle: Type.String(),
			kind: Type.Union([
				Type.Literal("turn"),
				Type.Literal("tool"),
				Type.Literal("artifact"),
				Type.Literal("doc"),
			]),
			title: Type.String(),
			date: Type.String(),
			snippet: Type.String(),
			class: Type.Union([Type.Literal("normal"), Type.Literal("local-only")]),
			provider: Type.Optional(Type.String()),
			id: Type.Optional(Type.String()),
		}),
	),
});
export type RecallSearchOutput = Static<typeof RecallSearchOutput>;

export interface PublishedHooksDeps {
	db(): RecallDb;
	searcher(): Searcher;
	meta(id: number): Promise<SessionMeta>;
	now(): number;
}

function requireUser(call: PublishedHookCall, name: string): string {
	if (call.user === undefined) throw new Error(`${name} needs a user`);
	return call.user;
}

/** Resolve a "d:<docs.id>" handle to its item; every other handle is ignored. */
function docItemByHandle(db: RecallDb, handle: string): ItemRow | undefined {
	if (!handle.startsWith("d:")) return undefined;
	const id = Number(handle.slice(2));
	if (!Number.isInteger(id)) return undefined;
	return db.itemByDoc(id);
}

/** Strictest class wins; unknown handles are ignored. */
function taintedClass(
	db: RecallDb,
	cls: Confidentiality,
	sources: readonly string[],
): Confidentiality {
	let result = cls;
	for (const handle of sources) {
		if (docItemByHandle(db, handle)?.cls === "local-only") result = "local-only";
	}
	return result;
}

function docOf(hit: { item: ItemRow }, db: RecallDb): DocRow | undefined {
	return hit.item.doc === null ? undefined : db.doc(hit.item.doc);
}

/**
 * The extension-to-extension seam: named, schema-validated hooks other
 * extensions call through the core registry (see Task 2's PublishedHook).
 * Docs are keyed (call.caller, call.user, id) so one extension can never
 * overwrite another's record.
 */
export function createPublishedHooks(
	deps: PublishedHooksDeps,
): readonly PublishedHook[] {
	const index: PublishedHook = {
		name: "recall.index",
		description:
			"Store a user-owned document (a knowledge card) and index it for recall.",
		input: RecallIndexInput,
		output: RecallIndexOutput,
		async run(payload, call) {
			const input = payload as RecallIndexInput;
			const owner = requireUser(call, "recall.index");
			const db = deps.db();
			const cls = taintedClass(db, input.class ?? "normal", input.sources ?? []);
			const at = Date.parse(input.date);
			if (Number.isNaN(at)) {
				throw new Error("recall.index needs an ISO date");
			}
			const stored = db.upsertDoc(
				{
					provider: call.caller,
					docId: input.id,
					owner,
					kind: input.kind,
					title: input.title,
					url: input.url ?? null,
					at,
					cls,
					text: input.text,
					sources: input.sources ?? [],
				},
				deps.now(),
			);
			return { handle: `d:${stored.id}`, class: cls, changed: stored.changed };
		},
	};

	const remove: PublishedHook = {
		name: "recall.remove",
		description: "Delete a stored document by its caller-scoped id.",
		input: RecallRemoveInput,
		output: RecallRemoveOutput,
		async run(payload, call) {
			const input = payload as RecallRemoveInput;
			const owner = requireUser(call, "recall.remove");
			return {
				removed: deps.db().removeDoc(call.caller, owner, input.id),
			};
		},
	};

	const search: PublishedHook = {
		name: "recall.search",
		description:
			"Search recall's index; without a user it returns no hits, and without a model only normal-class items surface.",
		input: RecallSearchInput,
		output: RecallSearchOutput,
		async run(payload, call) {
			const input = payload as RecallSearchInput;
			if (call.user === undefined) return { hits: [] };
			const conversationId =
				call.conversationId === undefined ? undefined : Number(call.conversationId);
			const currentMeta =
				conversationId === undefined
					? undefined
					: await deps.meta(conversationId).catch(() => undefined);
			// No conversation meta: fall back to a private owner-only audience.
			const current =
				currentMeta === undefined
					? { conversationId, owner: call.user }
					: {
							conversationId,
							owner: currentMeta.owner,
							sharing: currentMeta.sharing,
						};
			const hits = await deps.searcher().search(
				input.query,
				{
					current,
					model:
						input.model === undefined
							? undefined
							: { provider: input.model.provider },
					includeJobs: true,
					kinds: input.kinds,
				},
				input.limit ?? 10,
			);
			return {
				hits: hits.map((hit) => {
					const doc = hit.item.kind === "doc" ? docOf(hit, deps.db()) : undefined;
					return {
						handle: hit.handle,
						kind: hit.item.kind,
						title:
							doc?.title ??
							hit.conversationTitle ??
							`conversation ${hit.item.conversationId}`,
						date: new Date(hit.item.at).toISOString(),
						snippet: hit.snippet,
						class: hit.item.cls,
						...(doc === undefined
							? {}
							: { provider: doc.provider, id: doc.docId }),
					};
				}),
			};
		},
	};

	return [index, remove, search];
}
