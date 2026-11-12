import type {
	EntryRecord,
	GenerationHooks,
	HookApi,
} from "@earendil-works/pi-durable";
import type {
	AssistantMessage,
	Message,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { RecallDb } from "../src/db.js";
import createRecall from "../src/index.js";
import type { Hit, Searcher } from "../src/search.js";
import {
	applySittings,
	SITTING_HEADER,
	type SittingRequestDeps,
} from "../src/sittings/request.js";
import { applyRecall } from "../src/inject.js";
import { createLineageMemo, type EntriesReader } from "../src/sittings/lineage.js";
import { withDeclaredSettings } from "./fake-host.js";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 5, 12);
const BOUNDARY = T0 + 2 * HOUR;

const openDatabases: RecallDb[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
	for (const db of openDatabases.splice(0)) db.close();
	for (const root of tempRoots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

function memoryDb(): RecallDb {
	const db = RecallDb.open(":memory:");
	openDatabases.push(db);
	return db;
}

function user(text: string, timestamp: number): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "acme-local",
		model: "chat-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function entry(
	id: number,
	conversationId: number,
	kind: string,
	message: Message | undefined,
): EntryRecord {
	return {
		id,
		conversationId,
		kind,
		...(message === undefined ? {} : { model: [message] }),
	} as unknown as EntryRecord;
}

/** The three-turn fixture: old exchange, then the post-gap boundary question. */
function fixture(): { entries: EntryRecord[]; messages: Message[] } {
	const u1 = user("old question", T0);
	const a1 = assistant("old answer", T0 + 1_000);
	const u2 = user("boundary question", BOUNDARY);
	return {
		entries: [
			entry(1, 1, "pi.user", u1),
			entry(2, 1, "pi.assistant", a1),
			entry(3, 1, "pi.user", u2),
		],
		messages: [u1, a1, u2],
	};
}

function reader(entries: readonly EntryRecord[]): EntriesReader {
	return async (query, limit, cursor) => {
		const start = typeof cursor === "number" ? cursor : 0;
		const sorted = [...entries].sort((a, b) =>
			query.order === "ascending" ? a.id - b.id : b.id - a.id,
		);
		const filtered = sorted.filter(
			(value) =>
				(query.minEntryId === undefined || value.id >= query.minEntryId) &&
				(query.maxEntryId === undefined || value.id <= query.maxEntryId),
		);
		const items = filtered.slice(start, start + limit);
		return {
			items,
			next: start + items.length < filtered.length ? start + items.length : undefined,
		};
	};
}

function hit(text: string, id: number, cls: "normal" | "local-only" = "normal"): Hit {
	return {
		item: {
			id,
			conversationId: 7,
			owner: "alice",
			kind: "turn",
			entryId: 1,
			messageIndex: 0,
			blockIndex: 0,
			offset: 0,
			length: text.length,
			artifact: null,
			doc: null,
			job: false,
			cls,
			at: T0 - HOUR,
			title: null,
		},
		score: 1,
		snippet: text,
		handle: `r:${id}`,
		conversationTitle: "Earlier chat",
	};
}

const NO_HITS: Searcher = { search: async () => [] };

function searchHits(hits: Hit[]): Searcher {
	return { search: async () => hits };
}

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		pinned: false,
		tagged: [],
		archived: false,
		draft: { text: "", attachments: [] },
		source: "test",
		owner: "alice",
		...overrides,
	} as SessionMeta;
}

function deps(overrides: Partial<SittingRequestDeps> = {}): SittingRequestDeps {
	return {
		conversationId: 1,
		db: memoryDb(),
		meta: meta(),
		enabled: true,
		options: { minGapMs: HOUR, minHistoryTokens: 0 },
		model: undefined,
		isLocal: () => false,
		read: async () => ({ items: [] }),
		searcher: NO_HITS,
		readable: async () => true,
		...overrides,
	};
}

function textParts(message: Message | undefined): string[] {
	if (message === undefined || message.role !== "user") return [];
	return typeof message.content === "string"
		? [message.content]
		: message.content
				.filter((part) => part.type === "text")
				.map((part) => (part.type === "text" ? part.text : ""));
}

describe("applySittings", () => {
	it("a return after the gap draws one boundary and trims the request", async () => {
		const { entries, messages } = fixture();
		const db = memoryDb();
		const d = deps({
			db,
			read: reader(entries),
			searcher: searchHits([hit("remembered detail", 1)]),
		});
		const result = await applySittings(messages, d);

		expect(result.skipTimestamps).toEqual(new Set([BOUNDARY]));
		expect(result.rule.boundary).toEqual({ entryId: 3, at: BOUNDARY });
		expect(result.messages?.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
		// The previous exchange is re-attached; old turns are gone.
		expect(result.messages?.[0]).toMatchObject({
			role: "user",
			content: [{ type: "text", text: "old question" }],
		});
		const parts = textParts(result.messages?.[2]);
		expect(parts[0]).toContain(SITTING_HEADER);
		expect(parts[0]).toContain("[Recalled from past conversations");
		expect(parts[0]).toContain("remembered detail");
		expect(parts[1]).toBe("boundary question");
		// The stored decision and sitting are durable.
		expect(db.decision(1, 3)).toBe(true);
		const sitting = db.sittings([1]).find((row) => row.boundary);
		expect(sitting?.startEntryId).toBe(3);
		expect(sitting?.startAt).toBe(BOUNDARY);
		expect(sitting?.block?.header).toBe(SITTING_HEADER);
		expect(sitting?.block?.recall.sources).toEqual([1]);
		// The first, non-boundary sitting was created for the first user entry.
		expect(db.sittings([1]).find((row) => !row.boundary)?.startEntryId).toBe(1);
	});

	it("the same request prepared twice is deep-equal, even after the settings change and new items", async () => {
		const { entries, messages } = fixture();
		const db = memoryDb();
		const d = deps({
			db,
			read: reader(entries),
			searcher: searchHits([hit("remembered detail", 1)]),
		});
		const first = await applySittings(messages, d);
		// Live settings change between calls, and another item becomes searchable.
		const second = await applySittings(messages, {
			...d,
			options: { minGapMs: 600 * 60_000, minHistoryTokens: 999_999 },
			searcher: searchHits([hit("remembered detail", 1), hit("new item", 2)]),
		});
		expect(second).toEqual(first);
	});

	it("a second attempt does not reseal or rebuild", async () => {
		const { entries, messages } = fixture();
		const db = memoryDb();
		const d = deps({
			db,
			read: reader(entries),
			searcher: searchHits([hit("remembered detail", 1)]),
		});
		await applySittings(messages, d);
		const sealed = db.lines([1]).find((line) => line.startEntryId === 1);
		expect(sealed?.sealed).toBe(true);

		// Another attempt, with different hits available, changes nothing stored.
		await applySittings(messages, {
			...d,
			searcher: searchHits([hit("different item", 9)]),
		});
		const lines = db.lines([1]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toEqual(sealed);
		const sitting = db.sittings([1]).find((row) => row.boundary);
		expect(sitting?.block?.recall.sources).toEqual([1]);
	});

	it("later requests in the sitting share the exact prefix", async () => {
		const { entries, messages } = fixture();
		const db = memoryDb();
		const d = deps({
			db,
			read: reader(entries),
			searcher: searchHits([hit("remembered detail", 1)]),
		});
		const first = await applySittings(messages, d);

		const u3 = user("follow-up question", BOUNDARY + 60_000);
		const a3 = assistant("boundary answer", BOUNDARY + 30_000);
		const second = await applySittings([...messages, a3, u3], {
			...d,
			read: reader([...entries, entry(4, 1, "pi.assistant", a3), entry(5, 1, "pi.user", u3)]),
		});
		expect(second.messages).toBeDefined();
		// No new boundary was drawn for the follow-up.
		expect(db.decision(1, 5)).toBe(false);
		expect(second.messages?.slice(0, first.messages!.length)).toEqual(first.messages);
		expect(JSON.stringify(second.messages?.slice(0, first.messages!.length))).toBe(
			JSON.stringify(first.messages),
		);
		// The follow-up carries no sitting block.
		expect(textParts(second.messages?.at(-1))).toEqual(["follow-up question"]);
	});

	it("a follow-up gets ordinary recall while only the boundary is skipped", async () => {
		const { entries, messages } = fixture();
		const db = memoryDb();
		const d = deps({ db, read: reader(entries) });
		await applySittings(messages, d);
		const a3 = assistant("boundary answer", BOUNDARY + 30_000);
		const followUp = user("follow-up question", BOUNDARY + 60_000);
		const nextMessages = [...messages, a3, followUp];
		const nextEntries = [
			...entries,
			entry(4, 1, "pi.assistant", a3),
			entry(5, 1, "pi.user", followUp),
		];
		const result = await applySittings(nextMessages, {
			...d,
			read: reader(nextEntries),
		});
		expect(result.skipTimestamps).toEqual(new Set([BOUNDARY]));
		expect(result.skipTimestamps.has(followUp.timestamp)).toBe(false);

		let searches = 0;
		// Ordinary applyRecall rechecks the stored hit against the real item
		// table before rendering it.
		const source = hit("follow-up reference", 11).item;
		const sourceId = db.insertItem({ ...source }, "follow-up reference")!;
		const recalled = await applyRecall(result.messages!, {
			conversationId: 1,
			db,
			searcher: {
				search: async () => {
					searches += 1;
					return [hit("follow-up reference", sourceId)];
				},
			},
			meta: meta(),
			model: undefined,
			autoRecall: true,
			internal: false,
			inContext: result.rule,
			skipTimestamps: result.skipTimestamps,
			isLocal: () => false,
			sourceMeta: async () => meta(),
		});
		expect(searches).toBe(1);
		expect(textParts(recalled?.at(-1))).toEqual([
			"follow-up question",
			expect.stringContaining("follow-up reference"),
		]);
		const boundaryText = textParts(recalled?.find(
			(message) => message.timestamp === BOUNDARY,
		)).join("\n");
		expect(boundaryText.split("[Recalled from past conversations").length - 1).toBe(0);
	});

	it("a fork anchors its first sitting at its own first user entry", async () => {
		const { messages } = fixture();
		const entries: EntryRecord[] = [
			entry(1, 1, "pi.user", user("ancestor question", T0 - HOUR)),
			...fixture().entries.map((row) =>
				entry(row.id, 2, row.kind, row.model?.[0]),
			),
		];
		const db = memoryDb();
		const result = await applySittings(messages, deps({
			conversationId: 2,
			db,
			read: reader(entries),
		}));
		expect(result.messages).toBeDefined();
		const first = db.sittings([2]).find((row) => !row.boundary);
		expect(first?.startEntryId).toBe(1);
		expect(first?.boundaryText).toBe("old question");
		expect(db.sittings([2])).toHaveLength(2);
		expect(db.lines([2])).toHaveLength(1);
	});

	it("the lineage memo avoids rescanning inherited entries on later requests", async () => {
		const { entries, messages } = fixture();
		const db = memoryDb();
		const memo = createLineageMemo();
		let lineageScans = 0;
		const countingRead: EntriesReader = async (query, limit, cursor) => {
			if (query.order === "ascending") lineageScans += 1;
			return reader(entries)(query, limit, cursor);
		};
		const d = deps({ db, read: countingRead, lineageMemo: memo });
		await applySittings(messages, d);
		const firstLineageScans = lineageScans;
		await applySittings(messages, d);
		expect(lineageScans).toBe(firstLineageScans);
	});

	it("a local-only TOC line taints only when it is rendered", async () => {
		for (const local of [false, true]) {
			const { entries, messages } = fixture();
			const db = memoryDb();
			db.putLineDraft({
				conversationId: 1,
				startEntryId: 1,
				text: "private sitting summary",
				cls: "local-only",
				coversThrough: 3,
			});
			const result = await applySittings(messages, deps({
				db,
				read: reader(entries),
				model: { provider: local ? "acme-local" : "acme", id: "chat-1" },
				isLocal: () => local,
			}));
			const block = textParts(result.messages?.at(-1))[0]!;
			expect(block.includes("private sitting summary")).toBe(local);
			expect(db.taintFrom(1)).toBe(local ? 1 : undefined);
		}
	});

	it("a locally committed boundary trims a concurrent losing attempt", async () => {
		const { entries, messages } = fixture();
		const db = memoryDb();
		const d = deps({ db, read: reader(entries) });
		const original = db.createBoundary.bind(db);
		let raced = false;
		db.createBoundary = (row, seal) => {
			if (!raced) {
				raced = true;
				expect(original(row, seal)).toBe(true);
				return false;
			}
			return original(row, seal);
		};
		const result = await applySittings(messages, d);
		expect(result.messages).toBeDefined();
		expect(result.skipTimestamps).toEqual(new Set([BOUNDARY]));
		expect(result.rule.boundary).toEqual({ entryId: 3, at: BOUNDARY });
	});

	it("local-only recall text is withheld from a non-local model and taints when shown to a local one", async () => {
		const { entries, messages } = fixture();
		const localHit = hit("private detail", 1, "local-only");
		const db = memoryDb();
		const remote = await applySittings(messages, deps({
			db,
			read: reader(entries),
			searcher: searchHits([localHit]),
			model: { provider: "acme", id: "remote" },
			isLocal: () => false,
			readable: async () => false,
		}));
		expect(textParts(remote.messages?.at(-1))[0]).not.toContain("private detail");
		expect(db.taintFrom(1)).toBeUndefined();

		const localDb = memoryDb();
		const local = await applySittings(messages, deps({
			db: localDb,
			read: reader(entries),
			searcher: searchHits([localHit]),
			model: { provider: "acme-local", id: "chat-1" },
			isLocal: () => true,
			readable: async () => true,
		}));
		expect(textParts(local.messages?.at(-1))[0]).toContain("private detail");
		expect(localDb.taintFrom(1)).toBe(1);
	});

	it("an expanded /skill: input maps to its entry", async () => {
		const u1 = user("old question", T0);
		const a1 = assistant("old answer", T0 + 1_000);
		const expanded = user("/skill:review expanded instructions", BOUNDARY);
		const entries = [
			entry(1, 1, "pi.user", u1),
			entry(2, 1, "pi.assistant", a1),
			entry(3, 1, "sigrun.user.expanded", expanded),
		];
		const db = memoryDb();
		const result = await applySittings([u1, a1, expanded], deps({
			db,
			read: reader(entries),
		}));
		expect(db.decision(1, 3)).toBe(true);
		expect(result.rule.boundary).toEqual({ entryId: 3, at: BOUNDARY });
		expect(result.skipTimestamps).toEqual(new Set([BOUNDARY]));
	});

	it("the previous sitting's line is sealed at the boundary", async () => {
		const { entries, messages } = fixture();
		const db = memoryDb();
		await applySittings(messages, deps({ db, read: reader(entries) }));
		const line = db.lines([1]).find((candidate) => candidate.startEntryId === 1);
		expect(line?.sealed).toBe(true);
		expect(line?.coversThrough).toBe(3);
		expect(line?.text).toBe("old question");
		// The sealed line appears in the boundary sitting's stored table of contents.
		const sitting = db.sittings([1]).find((row) => row.boundary);
		expect(sitting?.block?.toc).toEqual([
			{
				startAt: T0,
				title: null,
				text: "old question",
				cls: "normal",
			},
		]);
	});

	it("a disabled user gets today's behaviour", async () => {
		const { entries, messages } = fixture();
		const db = memoryDb();
		const result = await applySittings(messages, deps({
			db,
			read: reader(entries),
			enabled: false,
		}));
		expect(result.messages).toBeUndefined();
		expect(result.skipTimestamps).toEqual(new Set());
		expect(result.rule.boundary).toBeUndefined();
		expect(db.decision(1, 3)).toBeUndefined();
		expect(db.sittings([1])).toEqual([]);
	});

	it("job, cron and internal conversations never draw a boundary; an ownerless conversation does", async () => {
		for (const ineligible of [
			meta({ jobId: "job-1" } as Partial<SessionMeta>),
			meta({ source: "cron" }),
			meta({ internal: true } as Partial<SessionMeta>),
		]) {
			const { entries, messages } = fixture();
			const db = memoryDb();
			const result = await applySittings(messages, deps({
				db,
				meta: ineligible,
				read: reader(entries),
			}));
			expect(result.messages).toBeUndefined();
			expect(result.skipTimestamps).toEqual(new Set());
			expect(db.decision(1, 3)).toBeUndefined();
			expect(db.sittings([1])).toEqual([]);
		}

		const { entries, messages } = fixture();
		const db = memoryDb();
		const result = await applySittings(messages, deps({
			db,
			meta: meta({ owner: undefined }),
			read: reader(entries),
		}));
		expect(result.messages).toBeDefined();
		expect(db.decision(1, 3)).toBe(true);
	});
});

describe("beforeRequest sittings wiring", () => {
	async function boot(overrides: {
		meta?: Partial<SessionMeta>;
		sharedSettings?: Record<string, unknown>;
		userSettings?: Record<string, unknown>;
		model?: { provider: string; modelId: string };
		promptCache?: { short?: number; long?: number };
		entries?: EntryRecord[];
	} = {}) {
		const root = await mkdtemp(join(tmpdir(), "recall-sittings-hook-"));
		tempRoots.push(root);
		const entries = overrides.entries ?? fixture().entries;
		const result = await createRecall(
			withDeclaredSettings({
				stores: {
					paths: { data: root },
					settings: { get: async () => overrides.sharedSettings ?? {} },
					user: () => ({ settings: { get: async () => overrides.userSettings ?? {} } }),
				},
				users: { list: async () => [] },
				models: { isLocal: () => false },
				conversations: {
					meta: async () => meta(overrides.meta),
					entry: async (conversationId: number, entryId: number) =>
						entries.find(
							(candidate) =>
								candidate.conversationId === conversationId && candidate.id === entryId,
						),
				},
			} as never),
		);
		const registration = result.extension?.hooks?.find(
			(candidate) => "beforeRequest" in candidate.handlers,
		);
		const beforeRequest = (
			registration!.handlers as Pick<GenerationHooks, "beforeRequest">
		).beforeRequest;
		const context = { name: "hook-context" };
		const api = {
			conversationId: 1,
			snapshot: async () =>
				overrides.model === undefined ? undefined : { model: overrides.model },
			entries: reader(entries),
			models: {
				getModel: () =>
					overrides.promptCache === undefined
						? undefined
						: { promptCache: overrides.promptCache },
			},
		};
		return { result, beforeRequest, api, context, root };
	}

	it("the boundary message carries exactly one recall block after the full path", async () => {
		// A searchable item from another conversation whose text shares a
		// token with the boundary question, so recall has a hit; its entry is
		// readable by the searcher's snippet lookup.
		const past = user("boundary question detail", T0 - HOUR);
		const { result, beforeRequest, api, context, root } = await boot({
			sharedSettings: { sittings: { minGapMinutes: 60, minHistoryTokens: 0 } },
			entries: [...fixture().entries, entry(1, 7, "pi.user", past)],
		});
		try {
			const db = RecallDb.open(join(root, "recall.db"));
			db.insertItem(
				{
					conversationId: 7,
					owner: "alice",
					kind: "turn",
					entryId: 1,
					messageIndex: 0,
					blockIndex: 0,
					offset: 0,
					length: 23,
					artifact: null,
					doc: null,
					job: false,
					cls: "normal",
					at: T0 - HOUR,
					title: null,
				},
				"boundary question detail",
			);
			db.close();
			const { messages } = fixture();
			const returned = await beforeRequest(
				{ messages },
				api as unknown as HookApi,
				context as never,
			);
			expect(returned).toBeDefined();
			const boundary = returned!.messages.at(-1)!;
			const text = textParts(boundary).join("\n");
			const occurrences = text.split("[Recalled from past conversations").length - 1;
			expect(occurrences).toBe(1);
			expect(text).toContain(SITTING_HEADER);
			// Old turns are trimmed; the previous exchange is re-attached.
			expect(returned!.messages.map((message) => message.role)).toEqual([
				"user",
				"assistant",
				"user",
			]);
		} finally {
			await result.harnessShutdown?.({} as never, {} as never);
		}
	});

	it("a disabled user still gets ordinary auto-recall, never a sitting", async () => {
		const { result, beforeRequest, api, context } = await boot({
			userSettings: { sittings: false },
		});
		try {
			const { messages } = fixture();
			const returned = await beforeRequest(
				{ messages },
				api as unknown as HookApi,
				context as never,
			);
			// No trimming, no sitting header; the request is today's behaviour.
			expect(returned).toBeUndefined();
		} finally {
			await result.harnessShutdown?.({} as never, {} as never);
		}
	});

	it("auto-recall off disables sittings as well as ordinary injection", async () => {
		const { result, beforeRequest, api, context } = await boot({
			sharedSettings: { sittings: { minGapMinutes: 60, minHistoryTokens: 0 } },
			userSettings: { autoRecall: false, sittings: true },
		});
		try {
			const { messages } = fixture();
			const returned = await beforeRequest(
				{ messages },
				api as unknown as HookApi,
				context as never,
			);
			expect(returned).toBeUndefined();
		} finally {
			await result.harnessShutdown?.({} as never, {} as never);
		}
	});

	it("the model's prompt cache lifetime raises the gap", async () => {
		const { result, beforeRequest, api, context } = await boot({
			sharedSettings: { sittings: { minGapMinutes: 60, minHistoryTokens: 0 } },
			model: { provider: "acme-local", modelId: "chat-1" },
			promptCache: { long: 3 * 3600 },
		});
		try {
			const { messages } = fixture();
			// The 2h gap is below the 3h cache lifetime: no boundary.
			const returned = await beforeRequest(
				{ messages },
				api as unknown as HookApi,
				context as never,
			);
			expect(returned).toBeUndefined();
		} finally {
			await result.harnessShutdown?.({} as never, {} as never);
		}
	});
});
