import type { Message, UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import { describe, expect, it, vi } from "vitest";

import { captureConversation } from "../src/capture.js";
import { RecallDb } from "../src/db.js";
import { applyRecall, messageKey, renderBlock, type InjectDeps } from "../src/inject.js";
import type { Hit, Searcher } from "../src/search.js";

const AT = Date.parse("2026-11-02T12:00:00Z");

function user(text: string, timestamp = AT): UserMessage {
	return { role: "user", content: text, timestamp };
}

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

function hit(cls: "normal" | "local-only" = "normal", snippet = "past clinic"): Hit {
	return {
		item: {
			id: 1,
			conversationId: 3,
			owner: "alice",
			kind: "turn",
			entryId: 1,
			messageIndex: 0,
			offset: 0,
			length: snippet.length,
			artifact: null,
			job: false,
			cls,
			at: AT,
			title: null,
		},
		score: 1,
		snippet,
		handle: "r:1",
		conversationTitle: "Past conversation",
	};
}

function setup(hits: Hit[] = [hit()], provider: string | undefined = "acme-local") {
	const db = RecallDb.open(":memory:");
	const search = vi.fn(async () => hits);
	const searcher: Searcher = { search };
	const deps: InjectDeps = {
		conversationId: 1,
		db,
		searcher,
		meta: meta(),
		model: provider === undefined ? undefined : { provider },
		autoRecall: true,
		internal: false,
		ownerLocalProviders: ["acme-local"],
	};
	return { db, deps, search };
}

function texts(messages: readonly Message[] | undefined): string[] {
	return (messages ?? []).flatMap((message) =>
		message.role === "user"
			? typeof message.content === "string"
				? [message.content]
				: message.content.map((part) => (part.type === "text" ? part.text : ""))
			: [],
	);
}

describe("automatic recall", () => {
	it("the first request of a run appends a recall block to the newest user message", async () => {
		const { db, deps } = setup();
		const result = await applyRecall([user("current question")], deps);
		expect(result?.at(-1)?.role).toBe("user");
		expect(texts(result).at(-1)).toContain("[Recalled from past conversations");
		expect(db.injections(1).get(messageKey(user("current question")))).toBeDefined();
		db.close();
	});

	it("a second request in the same run reuses the stored block without searching again", async () => {
		const { db, deps, search } = setup();
		const original = [user("current question")];
		const first = await applyRecall(original, deps);
		const second = await applyRecall(original, deps);
		expect(search).toHaveBeenCalledTimes(1);
		expect(second).toEqual(first);
		db.close();
	});

	it("on the next run, the earlier message carries the identical block bytes and the new message gets its own", async () => {
		const { db, deps } = setup();
		const first = await applyRecall([user("first question", AT)], deps);
		const earlier = texts(first)[1];
		const second = await applyRecall([...first!, user("second question", AT + 1)], deps);
		expect(texts(second)[1]).toBe(earlier);
		expect(texts(second).at(-1)).toContain("Recalled from past conversations");
		expect(db.injections(1).size).toBe(2);
		db.close();
	});

	it("autoRecall false stores nothing and changes nothing", async () => {
		const { db, deps, search } = setup();
		expect(await applyRecall([user("question")], { ...deps, autoRecall: false })).toBeUndefined();
		expect(search).not.toHaveBeenCalled();
		expect(db.injections(1).size).toBe(0);
		db.close();
	});

	it("internal conversations are never augmented", async () => {
		const { db, deps, search } = setup();
		expect(await applyRecall([user("question")], { ...deps, internal: true })).toBeUndefined();
		expect(search).not.toHaveBeenCalled();
		db.close();
	});

	it("a conversation with no configured model never receives local-only items", async () => {
		const { db, deps } = setup([hit("local-only")], undefined);
		const result = await applyRecall([user("question")], { ...deps, model: undefined });
		expect(result).toBeUndefined();
		expect(db.injections(1).get(messageKey(user("question")))?.cls).toBe("local-only");
		db.close();
	});

	it("a stored local-only block injected under acme-local is omitted after the conversation switches to acme-cloud, while a normal block on an earlier message stays byte-identical", async () => {
		const { db, deps, search } = setup();
		const earlier = await applyRecall([user("normal question", AT)], deps);
		const normalBlock = texts(earlier)[1]!;
		search.mockResolvedValue([hit("local-only")]);
		const local = await applyRecall([user("normal question", AT), user("local question", AT + 1)], {
			...deps,
			model: { provider: "acme-local" },
		});
		expect(texts(local).at(-1)).toContain("Recalled from past conversations");
		const switched = await applyRecall(
			[user("normal question", AT), user("local question", AT + 1)],
			{ ...deps, model: { provider: "acme-cloud" } },
		);
		expect(texts(switched)[1]).toBe(normalBlock);
		expect(texts(switched).at(-1)).not.toContain("Recalled from past conversations");
		db.close();
	});

	it("renderBlock keeps total snippet text ≤ 1536 bytes", () => {
		const block = renderBlock([hit("normal", "x".repeat(1000)), hit("normal", "y".repeat(1000))]);
		const snippets = block.split("\n").slice(1).map((line) => line.split(" · ")[2]?.split(" (r:")[0] ?? "");
		expect(snippets.reduce((total, snippet) => total + Buffer.byteLength(snippet), 0)).toBeLessThanOrEqual(1536);
		expect(block).toContain("…");
	});

	it('the injected text never reaches the index: after a run, captured passages contain no "[Recalled from past conversations" text', async () => {
		const { db, deps } = setup();
		await applyRecall([user("question")], deps);
		const entry = {
			id: 1,
			conversationId: 1,
			kind: "pi.message",
			model: [user("question")],
		} as unknown as EntryRecord;
		await captureConversation(
			{ db, meta: async () => meta(), now: () => AT },
			1,
			async () => ({ items: [entry] }),
		);
		expect(db.matchTrigram('"question"')).toEqual([1]);
		expect(db.matchTrigram('"Recalled from past"')).toEqual([]);
		db.close();
	});
});
