import type { EntryRecord } from "@earendil-works/pi-durable";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import { afterEach, describe, expect, it } from "vitest";

import { RecallDb } from "../src/db.js";
import {
	beforeCompactSittings,
	OVERFLOW_SUMMARY,
	SUMMARY_PROMPT,
} from "../src/sittings/compact.js";
import type { EntriesReader } from "../src/sittings/lineage.js";
import type { SittingRow } from "../src/sittings/types.js";

const T0 = Date.UTC(2026, 0, 5, 12);

const openDatabases: RecallDb[] = [];

afterEach(() => {
	for (const db of openDatabases.splice(0)) db.close();
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

function entry(id: number, kind: string, message: Message): EntryRecord {
	return {
		id,
		conversationId: 1,
		kind,
		model: [message],
	} as unknown as EntryRecord;
}

function turn(id: number, text: string): EntryRecord {
	return entry(id, "pi.user", user(text, T0 + id * 1_000));
}

function marker(id: number, head: number, text: string): EntryRecord {
	return {
		id,
		conversationId: 1,
		kind: "pi.compaction",
		model: [user(text, T0 + id * 1_000)],
		head,
		data: { reason: "overflow" },
	} as unknown as EntryRecord;
}

function boundarySitting(startEntryId: number): SittingRow {
	return {
		conversationId: 1,
		startEntryId,
		startAt: T0 + startEntryId * 1_000,
		boundary: true,
		boundaryText: "boundary question",
		previous: null,
		block: null,
		title: null,
		titleState: "none",
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

interface CompleteCall {
	role?: "utility";
	systemPrompt?: string;
	prompt: string;
	timeoutMs?: number;
}

function completeStub(
	answer: string | Error = "summary",
): { complete: SigrunHost["models"]["complete"]; calls: CompleteCall[] } {
	const calls: CompleteCall[] = [];
	return {
		calls,
		complete: async (input) => {
			calls.push(input);
			if (answer instanceof Error) throw answer;
			return { text: answer, model: "acme-local/chat-1" };
		},
	};
}

function deps(overrides: {
	db?: RecallDb;
	entries?: EntryRecord[];
	complete?: SigrunHost["models"]["complete"];
} = {}) {
	return {
		conversationId: 1,
		db: overrides.db ?? memoryDb(),
		read: reader(overrides.entries ?? []),
		complete: overrides.complete ?? completeStub().complete,
	};
}

describe("beforeCompactSittings", () => {
	it("returns undefined without a current boundary sitting", async () => {
		const { complete, calls } = completeStub();
		const result = await beforeCompactSittings(
			{ reason: "threshold", entries: [turn(1, "one")], firstKept: 1 },
			deps({ complete }),
		);
		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	it("returns before reading lineage when no sittings exist", async () => {
		const db = memoryDb();
		let reads = 0;
		const read: EntriesReader = async () => {
			reads += 1;
			throw new Error("lineage read should not happen");
		};
		const { complete, calls } = completeStub();
		const result = await beforeCompactSittings(
			{ reason: "threshold", entries: [turn(1, "one")], firstKept: 1 },
			{ ...deps({ db, complete }), read },
		);
		expect(result).toBeUndefined();
		expect(reads).toBe(0);
		expect(calls).toHaveLength(0);
	});

	it("declines a threshold compaction before the boundary", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		const { complete, calls } = completeStub();
		const result = await beforeCompactSittings(
			{ reason: "threshold", entries: [turn(1, "one"), turn(2, "two")], firstKept: 30 },
			deps({ db, complete }),
		);
		expect(result).toEqual({ decline: true });
		expect(calls).toHaveLength(0);
	});

	it("an overflow compaction before the boundary never declines", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		const { complete, calls } = completeStub();
		const result = await beforeCompactSittings(
			{ reason: "overflow", entries: [turn(1, "one"), turn(2, "two")], firstKept: 30 },
			deps({ db, complete }),
		);
		expect(result).toEqual({ summary: OVERFLOW_SUMMARY });
		expect(calls).toHaveLength(0);
	});

	it("a manual compaction before the boundary gets the fixed summary", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		const { complete, calls } = completeStub();
		const result = await beforeCompactSittings(
			{ reason: "manual", entries: [turn(1, "one"), turn(2, "two")], firstKept: 40 },
			deps({ db, complete }),
		);
		expect(result).toEqual({ summary: OVERFLOW_SUMMARY });
		expect(calls).toHaveLength(0);
	});

	it("summarizes only in-sitting entries when the range reaches before the boundary", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		const entries = [turn(10, "old question"), turn(41, "new question"), turn(42, "newer")];
		const { complete, calls } = completeStub("in-sitting summary");
		const result = await beforeCompactSittings(
			{ reason: "threshold", entries, firstKept: 50 },
			deps({ db, complete }),
		);
		expect(result).toEqual({ summary: "in-sitting summary" });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.role).toBe("utility");
		expect(calls[0]!.systemPrompt).toBe(SUMMARY_PROMPT);
		expect(calls[0]!.timeoutMs).toBe(120_000);
		expect(calls[0]!.prompt).toContain("new question");
		expect(calls[0]!.prompt).toContain("newer");
	});

	it("the summarizer never receives a pre-boundary message", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		const entries = [
			turn(10, "OLD-SECRET pre-boundary text"),
			entry(20, "pi.assistant", assistant("OLD-ANSWER pre-boundary reply", T0 + 20_000)),
			turn(41, "fresh in-sitting question"),
		];
		const { complete, calls } = completeStub();
		const result = await beforeCompactSittings(
			{ reason: "threshold", entries, firstKept: 50 },
			deps({ db, complete }),
		);
		expect(result).toEqual({ summary: "summary" });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.prompt).toContain("fresh in-sitting question");
		expect(calls[0]!.prompt).not.toContain("OLD-SECRET");
		expect(calls[0]!.prompt).not.toContain("OLD-ANSWER");
	});

	it("includes an earlier in-sitting summary marker whose head is inside the sitting", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		const entries = [
			marker(60, 45, "EARLIER-SUMMARY within the sitting"),
			turn(10, "pre-boundary question"),
			turn(50, "in-sitting question"),
		];
		const { complete, calls } = completeStub();
		const result = await beforeCompactSittings(
			{ reason: "threshold", entries, firstKept: 70 },
			deps({ db, complete }),
		);
		expect(result).toEqual({ summary: "summary" });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.prompt).toContain("EARLIER-SUMMARY");
		expect(calls[0]!.prompt).toContain("in-sitting question");
		expect(calls[0]!.prompt).not.toContain("pre-boundary question");
	});

	it("a second compaction after an in-sitting overflow summary is classified by the marker's head, not its id", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		// The marker's id (90) is above the boundary but its head (30) points
		// BEFORE it: the range reaches before the boundary, so the summarizer
		// runs — and sees only e40..e60, never the marker's own summary text.
		const entries = [
			marker(90, 30, "PRE-BOUNDARY-SUMMARY text"),
			...Array.from({ length: 30 }, (_, index) => turn(31 + index, `turn ${31 + index}`)),
		];
		const { complete, calls } = completeStub();
		const result = await beforeCompactSittings(
			{ reason: "overflow", entries, firstKept: 70 },
			deps({ db, complete }),
		);
		expect(result).toEqual({ summary: "summary" });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.prompt).toContain("turn 40");
		expect(calls[0]!.prompt).toContain("turn 60");
		expect(calls[0]!.prompt).not.toContain("turn 39");
		expect(calls[0]!.prompt).not.toContain("PRE-BOUNDARY-SUMMARY");
	});

	it("a pre-boundary head marker alone does not force the fixed summary when firstKept is before the boundary", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		// Head marker first, exactly as pi-durable passes it.
		const entries = [marker(90, 30, "old summary"), turn(41, "in-sitting"), turn(42, "more")];
		const { complete, calls } = completeStub();
		const result = await beforeCompactSittings(
			{ reason: "threshold", entries, firstKept: 50 },
			deps({ db, complete }),
		);
		expect(result).toEqual({ summary: "summary" });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.prompt).not.toContain("old summary");
		expect(calls[0]!.prompt).toContain("in-sitting");
	});

	it("returns undefined when the range is entirely after the boundary", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		const { complete, calls } = completeStub();
		const result = await beforeCompactSittings(
			{ reason: "threshold", entries: [turn(41, "one"), turn(42, "two")], firstKept: 45 },
			deps({ db, complete }),
		);
		expect(result).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	it("a summarizer failure on overflow returns the fixed summary", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		const { complete, calls } = completeStub(new Error("model unavailable"));
		const result = await beforeCompactSittings(
			{ reason: "overflow", entries: [turn(10, "old"), turn(41, "new")], firstKept: 50 },
			deps({ db, complete }),
		);
		expect(result).toEqual({ summary: OVERFLOW_SUMMARY });
		expect(calls).toHaveLength(1);
	});

	it("a summarizer failure on threshold declines", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		const { complete } = completeStub(new Error("model unavailable"));
		const result = await beforeCompactSittings(
			{ reason: "threshold", entries: [turn(10, "old"), turn(41, "new")], firstKept: 50 },
			deps({ db, complete }),
		);
		expect(result).toEqual({ decline: true });
	});

	it("a pre-boundary marker triggers summarization even when every entry id is after the boundary", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		// rangeStart (40) is not before the boundary: ONLY the marker's
		// top-level head (30) can select the in-sitting summarizer.
		const entries = [
			marker(90, 30, "PRE-BOUNDARY-SUMMARY text"),
			...Array.from({ length: 21 }, (_, index) => turn(40 + index, `turn ${40 + index}`)),
		];
		const { complete, calls } = completeStub("marker-classified summary");
		const result = await beforeCompactSittings(
			{ reason: "overflow", entries, firstKept: 61 },
			deps({ db, complete }),
		);
		expect(result).toEqual({ summary: "marker-classified summary" });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.prompt).toContain("turn 40");
		expect(calls[0]!.prompt).toContain("turn 60");
		expect(calls[0]!.prompt).not.toContain("PRE-BOUNDARY-SUMMARY");
	});

	it("an empty completion on overflow falls back to the fixed summary", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		const { complete, calls } = completeStub("  \n");
		const result = await beforeCompactSittings(
			{ reason: "overflow", entries: [turn(10, "old"), turn(41, "new")], firstKept: 50 },
			deps({ db, complete }),
		);
		expect(result).toEqual({ summary: OVERFLOW_SUMMARY });
		expect(calls).toHaveLength(1);
	});

	it("an empty completion on a manual compaction falls back to the fixed summary", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		const { complete } = completeStub("");
		const result = await beforeCompactSittings(
			{ reason: "manual", entries: [turn(10, "old"), turn(41, "new")], firstKept: 50 },
			deps({ db, complete }),
		);
		expect(result).toEqual({ summary: OVERFLOW_SUMMARY });
	});

	it("an empty completion on threshold declines", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		const { complete } = completeStub("");
		const result = await beforeCompactSittings(
			{ reason: "threshold", entries: [turn(10, "old"), turn(41, "new")], firstKept: 50 },
			deps({ db, complete }),
		);
		expect(result).toEqual({ decline: true });
	});

	it("caps the summarizer prompt at 24000 chars", async () => {
		const db = memoryDb();
		db.putSitting(boundarySitting(40));
		const entries = [
			turn(10, "old"),
			turn(41, "x".repeat(30_000)),
		];
		const { complete, calls } = completeStub();
		const result = await beforeCompactSittings(
			{ reason: "threshold", entries, firstKept: 50 },
			deps({ db, complete }),
		);
		expect(result).toEqual({ summary: "summary" });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.prompt.length).toBeLessThanOrEqual(24_000);
	});
});
