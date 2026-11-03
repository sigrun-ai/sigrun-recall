import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";

import createRecall from "../src/index.js";
import { RecallDb } from "../src/db.js";

describe("createRecall", () => {
  it("factory.length === 1", () => {
    expect(createRecall.length).toBe(1);
  });

  it("defers the database until use and closes it at harness shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "recall-lifecycle-"));
		let opened = 0;
		const result = createRecall(
			{ stores: { paths: { data: root }, settings: { get: async () => ({}) } } } as never,
			{
				openDb: (path) => {
					opened += 1;
					return RecallDb.open(path);
				},
			},
		);
    expect(opened).toBe(0);
		expect(result.routes).toHaveLength(2);
		expect(opened).toBe(0);
		await result.routes![0]!.handler(new Request("https://example.invalid/search?q=empty"), {
			principal: { user: "alice", admin: false },
		} as never);
		expect(opened).toBe(1);
    await result.harnessShutdown?.({} as never, {} as never);
    await rm(root, { recursive: true, force: true });
  });

  it("factory result declares the backfill job, both tools, both hooks and both routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "recall-index-"));
    const result = createRecall({
      stores: {
        paths: { data: root },
        settings: { get: async () => ({}) },
      },
    } as never);
    expect(result.jobs).toEqual([
      expect.objectContaining({
        name: "backfill",
        schedule: { cron: "*/10 * * * *" },
      }),
    ]);
    expect(result.extension?.tools?.map((tool) => tool.name)).toEqual([
      "recall_search",
      "recall_open",
    ]);
    expect(
      result.extension?.tasks?.map((task) => task.definition.name),
    ).toEqual(["recall.backfill"]);
    expect(result.extension?.hooks).toHaveLength(2);
    expect(
      result.routes?.map((route) => `${route.method} ${route.path}`),
    ).toEqual(["GET search", "POST backfill"]);
    await rm(root, { recursive: true, force: true });
  });

  it(
    "shutdown returns by the deadline when a capture never settles",
    { timeout: 15_000 },
    async () => {
      vi.useFakeTimers();
      try {
        const root = await mkdtemp(join(tmpdir(), "recall-drain-"));
        let closeCount = 0;
        const result = createRecall(
          {
            stores: {
              paths: { data: root },
              settings: {
                get: async () => ({
                  embedding: {
                    url: "https://embeddings.example.invalid",
                    model: "acme-embed-1",
                  },
                }),
              },
              secrets: { get: async () => undefined },
            },
            conversations: {
              meta: async () => ({
                pinned: false,
                tagged: [],
                archived: false,
                draft: { text: "", attachments: [] },
                source: "test",
              }),
            },
          } as never,
          {
            openDb: (path) => {
              const db = RecallDb.open(path);
              const originalClose = db.close.bind(db);
              db.close = () => {
                closeCount += 1;
                originalClose();
              };
              return db;
            },
            // Never settles: one capture stays pending forever.
            fetchImpl: () => new Promise<Response>(() => {}),
          },
        );
        const entry = {
          id: 1,
          conversationId: 1,
          kind: "pi.message",
          model: [
            {
              role: "assistant",
              content: [{ type: "text", text: "answer" }],
              timestamp: 1_700_000_000_000,
            },
          ],
        } as unknown as EntryRecord;
        const api = {
          entries: async () => ({ items: [entry] }),
        };
        await result.runSettled?.(
          { conversationId: 1 } as never,
          api as never,
          {} as never,
        );
        const shutdown = result.harnessShutdown?.({} as never, {} as never);
        expect(shutdown).toBeDefined();
        let resolved = false;
        void shutdown!.then(() => {
          resolved = true;
        });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(resolved).toBe(true);
        expect(closeCount).toBe(1);
        await rm(root, { recursive: true, force: true });
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
