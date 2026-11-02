import type { SessionMeta } from "@sigrun/shared/session-meta";
import { describe, expect, it } from "vitest";

import { RecallDb } from "../src/db.js";
import { createRoutes } from "../src/route.js";
import { createSearcher } from "../src/search.js";

function meta(owner: string): SessionMeta {
	return {
		pinned: false,
		tagged: [],
		archived: false,
		draft: { text: "", attachments: [] },
		source: "test",
		owner,
	};
}

function principal(user: string | undefined, admin = false) {
	return { user, admin, service: false, method: "session" as const };
}

describe("routes", () => {
	it("the route requires a user and returns only the caller's readable material", async () => {
		const db = RecallDb.open(":memory:");
		for (const [id, owner] of [[1, "alice"], [2, "bob"]] as const) {
			db.insertItem(
				{
					conversationId: id,
					owner,
					kind: "turn",
					entryId: 1,
					messageIndex: 0,
					offset: 0,
					length: 6,
					artifact: null,
					job: false,
					cls: "normal",
					at: 1_700_000_000_000,
					title: null,
				},
				"clinic",
			);
		}
		const searcher = createSearcher({
			db,
			meta: async (id) => meta(id === 1 ? "alice" : "bob"),
			entry: async (conversationId) => ({
				id: 1,
				conversationId,
				kind: "pi.message",
				model: [{ role: "user", content: "clinic", timestamp: 1_700_000_000_000 }],
			} as never),
			userSettings: async () => ({ autoRecall: true, localProviders: [] }),
			now: () => 1_700_000_000_000,
		});
		const routes = createRoutes({ searcher, sweep: async () => ({ indexed: 0, sweepAfter: 0 }) });
		const search = routes.find((route) => route.path === "search")!;
		const anonymous = await search.handler(new Request("https://example.invalid/search?q=clinic"), {
			principal: principal(undefined),
		} as never);
		expect(anonymous.status).toBe(401);
		const response = await search.handler(new Request("https://example.invalid/search?q=clinic"), {
			principal: principal("alice"),
		} as never);
		const body = await response.json();
		expect(body.hits).toEqual([
			expect.objectContaining({ conversationId: 1, handle: "r:1", snippet: "clinic" }),
		]);
		db.close();
	});

	it("the backfill route rejects a non-admin and runs one sweep for an admin", async () => {
		let calls = 0;
		const routes = createRoutes({
			searcher: { search: async () => [] },
			sweep: async () => {
				calls += 1;
				return { indexed: 2, sweepAfter: 7 };
			},
		});
		const backfill = routes.find((route) => route.path === "backfill")!;
		expect(backfill.auth).toBe("admin");
		const denied = await backfill.handler(new Request("https://example.invalid/backfill", { method: "POST" }), {
			principal: principal("alice", false),
		} as never);
		expect(denied.status).toBe(403);
		const response = await backfill.handler(new Request("https://example.invalid/backfill", { method: "POST" }), {
			principal: principal("alice", true),
		} as never);
		expect(await response.json()).toEqual({ indexed: 2, sweepAfter: 7 });
		expect(calls).toBe(1);
	});
});
