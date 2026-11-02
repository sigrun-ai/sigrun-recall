import type { EntryRecord } from "@earendil-works/pi-durable";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import { describe, expect, it } from "vitest";

import { runSweep } from "../src/backfill.js";
import { captureConversation } from "../src/capture.js";
import { RecallDb } from "../src/db.js";

const NOW = 1_700_000_000_000;

function entry(id: number, conversationId: number, text: string): EntryRecord {
	return {
		id,
		conversationId,
		kind: "pi.message",
		model: [{ role: "user", content: text, timestamp: NOW }],
	} as unknown as EntryRecord;
}

function host(entries: EntryRecord[], calls: number[] = []): SigrunHost {
	const ids = [...new Set(entries.map((value) => value.conversationId))];
	return {
		conversations: {
			list: async () => ids.map((id) => ({ id })),
			entries: async (
				id: number,
				query: { minEntryId?: number },
				limit: number,
			) => {
				calls.push(id);
				return {
					items: entries
						.filter((value) => value.conversationId === id)
						.filter((value) => query.minEntryId === undefined || value.id >= query.minEntryId)
						.slice(0, limit),
				};
			},
			meta: async () => ({
				pinned: false,
				tagged: [],
				archived: false,
				draft: { text: "", attachments: [] },
				source: "import",
				owner: "alice",
			}),
		},
	} as unknown as SigrunHost;
}

function deps(hostValue: SigrunHost, db: RecallDb, entryBudget = 2000) {
	return {
		host: hostValue,
		capture: captureConversation,
		db,
		now: () => NOW,
		entryBudget,
	};
}

describe("backfill", () => {
	it("backfill indexes a conversation that never had a run settle (an imported one)", async () => {
		const db = RecallDb.open(":memory:");
		const result = await runSweep(deps(host([entry(1, 1, "imported clinic")]), db));
		expect(result.indexed).toBe(1);
		expect(db.item(1)).toMatchObject({ conversationId: 1, entryId: 1 });
		db.close();
	});

	it("backfill interrupted mid-conversation and run again leaves exactly one item per passage", async () => {
		const db = RecallDb.open(":memory:");
		const source = host([entry(1, 1, "first passage"), entry(2, 1, "second passage")]);
		await runSweep(deps(source, db, 1));
		await runSweep(deps(source, db));
		expect(db.item(1)).toMatchObject({ entryId: 1 });
		expect(db.item(2)).toMatchObject({ entryId: 2 });
		expect(db.item(3)).toBeUndefined();
		db.close();
	});

	it("backfill resumes a conversation whose cursor is mid-transcript, and a caught-up conversation costs one empty read", async () => {
		const db = RecallDb.open(":memory:");
		const calls: number[] = [];
		const source = host([entry(1, 1, "first"), entry(2, 1, "second")], calls);
		await runSweep(deps(source, db, 1));
		await runSweep(deps(source, db));
		expect(db.item(2)?.entryId).toBe(2);
		await runSweep(deps(source, db));
		expect(calls.at(-1)).toBe(1);
		db.close();
	});

	it("backfill wraps around from sweepAfter so every conversation is visited within two runs", async () => {
		const db = RecallDb.open(":memory:");
		const source = host([entry(1, 1, "one"), entry(1, 2, "two")]);
		await runSweep(deps(source, db, 1));
		expect(db.item(1)?.conversationId).toBe(1);
		await runSweep(deps(source, db, 1));
		expect(db.item(2)?.conversationId).toBe(2);
		db.close();
	});
});
