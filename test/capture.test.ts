import type { EntryRecord } from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import { describe, expect, it } from "vitest";

import { captureConversation, type CaptureDeps, type EntryReader } from "../src/capture.js";
import { RecallDb } from "../src/db.js";

function messageEntry(
	id: number,
	conversationId: number,
	text: string,
	timestamp: number,
	role: "user" | "assistant" = "assistant",
): EntryRecord {
	return {
		id,
		conversationId,
		kind: "pi.message",
		model: [{ role, content: [{ type: "text", text }], timestamp }],
	} as unknown as EntryRecord;
}

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		pinned: false,
		tagged: [],
		archived: false,
		draft: { text: "", attachments: [] },
		source: "test",
		...overrides,
	};
}

function reader(entries: EntryRecord[]): EntryReader {
	return async (_query, _limit, _cursor) => ({ items: entries });
}

function setup(
	entries: EntryRecord[],
	sessionMeta: SessionMeta = meta({ owner: "alice", name: "Recall test" }),
): { db: RecallDb; deps: CaptureDeps } {
	const db = RecallDb.open(":memory:");
	return {
		db,
		deps: { db, meta: async () => sessionMeta, now: () => 1_700_000_000_000 },
	};
}

describe("captureConversation", () => {
	it("captureConversation indexes a settled run's user and assistant text with at = message timestamp", async () => {
		const entries = [
			messageEntry(1, 1, "question", 111, "user"),
			messageEntry(2, 1, "answer", 222),
		];
		const { db, deps } = setup(entries);
		try {
			expect(await captureConversation(deps, 1, reader(entries))).toEqual({ indexed: 2 });
			expect(db.item(1)).toMatchObject({
				conversationId: 1,
				owner: "alice",
				kind: "turn",
				entryId: 1,
				messageIndex: 0,
				offset: 0,
				length: 8,
				job: false,
				cls: "normal",
				at: 111,
				title: "Recall test",
			});
			expect(db.item(2)).toMatchObject({ entryId: 2, at: 222, length: 6 });
			expect(db.matchTrigram('"question"')).toEqual([1]);
			expect(db.matchTrigram('"answer"')).toEqual([2]);
		} finally {
			db.close();
		}
	});

	it("captureConversation called twice for the same entries leaves one item per passage", async () => {
		const entries = [messageEntry(1, 1, "repeat", 111, "user")];
		const { db, deps } = setup(entries);
		try {
			expect(await captureConversation(deps, 1, reader(entries))).toEqual({ indexed: 1 });
			expect(await captureConversation(deps, 1, reader(entries))).toEqual({ indexed: 0 });
			expect(db.item(1)).toMatchObject({ entryId: 1 });
			expect(db.item(2)).toBeUndefined();
			expect(db.cursor(1)).toBe(1);
		} finally {
			db.close();
		}
	});

	it("captureConversation for a fork child indexes only entries appended to the child", async () => {
		const entries = [
			messageEntry(1, 1, "parent question", 111, "user"),
			messageEntry(2, 1, "parent answer", 222),
			messageEntry(3, 2, "child answer", 333),
		];
		const { db, deps } = setup(entries);
		try {
			expect(await captureConversation(deps, 2, reader(entries))).toEqual({ indexed: 1 });
			expect(db.item(1)).toMatchObject({ conversationId: 2, entryId: 3 });
			expect(db.item(2)).toBeUndefined();
		} finally {
			db.close();
		}
	});

	it("captureConversation skips internal conversations and flags jobId conversations job=true", async () => {
		const entries = [messageEntry(1, 1, "internal", 111)];
		const internal = setup(entries, meta({ internal: true }));
		try {
			expect(await captureConversation(internal.deps, 1, reader(entries))).toEqual({ indexed: 0 });
			expect(internal.db.item(1)).toBeUndefined();
			expect(internal.db.cursor(1)).toBeUndefined();
		} finally {
			internal.db.close();
		}

		const job = setup([messageEntry(2, 2, "job", 222)], meta({ jobId: "job-1" }));
		try {
			await captureConversation(job.deps, 2, reader([messageEntry(2, 2, "job", 222)]));
			expect(job.db.item(1)?.job).toBe(true);
		} finally {
			job.db.close();
		}
	});

	it("entries after the taint point are captured as local-only", async () => {
		const entries = [
			messageEntry(1, 1, "before", 111),
			messageEntry(2, 1, "after", 222),
		];
		const { db, deps } = setup(entries);
		db.setTaint(1, 2);
		try {
			await captureConversation(deps, 1, reader(entries));
			expect(db.item(1)?.cls).toBe("normal");
			expect(db.item(2)?.cls).toBe("local-only");
		} finally {
			db.close();
		}
	});
});
