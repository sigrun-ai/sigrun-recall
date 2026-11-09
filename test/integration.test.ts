import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolExecutionResult, ToolHookCall } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";

import createRecall from "../src/index.js";

const NOW = 1_700_000_000_000;

async function host(root: string, embedding = false) {
	const entries = [
		{
			id: 1,
			conversationId: 1,
			kind: "pi.message",
			model: [{ role: "user", content: "canine knee operation", timestamp: NOW }],
		},
	];
	return {
		stores: {
			paths: { data: root },
			settings: {
				get: async () => embedding
					? { embedding: { url: "https://example.invalid/embed", model: "embed", local: false, timeoutMs: 800 } }
					: {},
			},
			secrets: { get: async () => undefined },
		},
		conversations: {
			meta: async () => ({ owner: "alice", name: "Past" }),
			entry: async () => entries[0],
			entries: async () => ({ items: entries }),
			list: async () => [{ id: 1 }],
		},
	} as never;
}

describe("factory integrations", () => {
	it("an artifact written by afterTool opens through the separately constructed tool store", async () => {
		const root = await mkdtemp(join(tmpdir(), "recall-integration-artifact-"));
		const result = await createRecall(await host(root));
		const hook = (result.extension!.hooks![0]!.handlers as {
			afterTool(call: ToolHookCall, result: ToolExecutionResult, api: never, context: Context): Promise<ToolExecutionResult | undefined>;
		}).afterTool;
		const large = "x".repeat(25_000);
		const replaced = await hook(
			{ type: "toolCall", id: "call", name: "web_fetch", arguments: { url: "https://example.invalid" } },
			{ output: [{ type: "text", text: large }] },
			{ conversationId: 1 } as never,
			{} as Context,
		);
		const stub = replaced?.output?.find((part) => part.type === "text");
		const handle = stub?.type === "text" ? stub.text.match(/a:[0-9a-f]{16}/)?.[0] : undefined;
		expect(handle).toBeDefined();
		const open = result.extension!.tools!.find((tool) => tool.name === "recall_open")!;
		const opened = await open.execute(
			{ handle, offset: 0, length: 10 } as never,
			{ conversationId: 1, agent: async () => ({ model: { provider: "acme-local" } }) } as unknown as ToolExecutionApi,
			{} as Context,
		);
		expect(opened.output?.[0]).toEqual({ type: "text", text: "x".repeat(10) });
		await result.harnessShutdown?.({} as never, {} as never);
		await rm(root, { recursive: true, force: true });
	});

	it("configured embeddings reach the production search route for a lexical-disjoint hit", async () => {
		const root = await mkdtemp(join(tmpdir(), "recall-integration-vector-"));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }), { status: 200 }),
		);
		const result = await createRecall(await host(root, true));
		const route = result.routes!.find((candidate) => candidate.path === "search")!;
		// Seed the real vector index through the same configured service used by capture.
		const backfill = result.routes!.find((candidate) => candidate.path === "backfill")!;
		await backfill.handler(new Request("https://example.invalid/backfill", { method: "POST" }), {
			principal: { user: "alice", admin: true },
		} as never);
		const response = await route.handler(new Request("https://example.invalid/search?q=dog+surgery"), {
			principal: { user: "alice", admin: false },
		} as never);
		const body = await response.json();
		expect(body.hits).toHaveLength(1);
		expect(body.hits[0].conversationId).toBe(1);
		fetchMock.mockRestore();
		await result.harnessShutdown?.({} as never, {} as never);
		await rm(root, { recursive: true, force: true });
	});
});
