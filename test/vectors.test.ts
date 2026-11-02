import type { EntryRecord } from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import { describe, expect, it, vi } from "vitest";

import { captureConversation } from "../src/capture.js";
import { RecallDb } from "../src/db.js";
import { createSearcher, type SearchContext } from "../src/search.js";
import type { Embedder } from "../src/embed.js";
import { createSqliteVectorIndex, createVectorArm } from "../src/vectors.js";

function meta(): SessionMeta {
	return {
		pinned: false,
		tagged: [],
		archived: false,
		draft: { text: "", attachments: [] },
		source: "test",
		owner: "alice",
	};
}

function entry(text: string): EntryRecord {
	return {
		id: 1,
		conversationId: 1,
		kind: "pi.message",
		model: [{ role: "user", content: text, timestamp: 1_700_000_000_000 }],
	} as unknown as EntryRecord;
}

function context(): SearchContext {
	return {
		current: { conversationId: 1, owner: "alice" },
		model: { provider: "acme-local" },
		includeJobs: false,
	};
}

describe("vectors", () => {
	it("a local-only item is not embedded by a non-local embedder", async () => {
		const db = RecallDb.open(":memory:");
		db.setTaint(1, 1);
		const embed = vi.fn(async (_texts: readonly string[]) => [new Float32Array([1])]);
		const embedder: Embedder = { local: false, embed };
		await captureConversation(
			{
				db,
				meta: async () => meta(),
				now: () => 1_700_000_000_000,
				embedder,
				index: createSqliteVectorIndex(db),
			},
			1,
			async () => ({ items: [entry("private semantic text")] }),
		);
		await vi.waitFor(() => expect(db.cursor(1)).toBe(1));
		expect(embed).not.toHaveBeenCalled();
		db.close();
	});

	it("capture-time embedding sends redacted text to the embedder", async () => {
		const db = RecallDb.open(":memory:");
		const embed = vi.fn(async (_texts: readonly string[]) => [new Float32Array([1])]);
		const embedder: Embedder = { local: false, embed };
		await captureConversation(
			{
				db,
				meta: async () => meta(),
				now: () => 1_700_000_000_000,
				embedder,
				index: createSqliteVectorIndex(db),
			},
			1,
			async () => ({
				items: [entry("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456")],
			}),
		);
		await vi.waitFor(() => expect(embed).toHaveBeenCalledOnce());
		const texts = embed.mock.calls[0]?.[0] ?? [];
		expect(texts).toEqual(["Authorization: [redacted:bearer]"]);
		expect(texts[0]).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
		db.close();
	});

	it('with a vector arm, a hit with no lexical overlap ("dog surgery" vs "canine knee operation") is found', async () => {
		const db = RecallDb.open(":memory:");
		const record = entry("canine knee operation");
		db.insertItem(
			{
				conversationId: 1,
				owner: "alice",
				kind: "turn",
				entryId: 1,
				messageIndex: 0,
				offset: 0,
				length: 21,
				artifact: null,
				job: false,
				cls: "normal",
				at: 1_700_000_000_000,
				title: null,
			},
			"canine knee operation",
		);
		const index = createSqliteVectorIndex(db);
		index.upsert(1, new Float32Array([1, 0]));
		const embedder: Embedder = {
			local: false,
			embed: async () => [new Float32Array([1, 0])],
		};
		const searcher = createSearcher({
			db,
			meta: async () => meta(),
			entry: async () => record,
			userSettings: async () => ({ autoRecall: true, localProviders: [] }),
			vectors: createVectorArm(embedder, index, 800),
			now: () => 1_700_000_000_000,
		});
		const hits = await searcher.search("dog surgery", context(), 10);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.item.id).toBe(1);
		db.close();
	});
});
