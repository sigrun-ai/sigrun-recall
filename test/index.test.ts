import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";

import createRecall from "../src/index.js";
import { withDeclaredSettings } from "./fake-host.js";
import { RecallDb } from "../src/db.js";

describe("createRecall", () => {
  it("factory.length === 1", () => {
    expect(createRecall.length).toBe(1);
  });

  it("defers the database until use and closes it at harness shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "recall-lifecycle-"));
		let opened = 0;
		const result = await createRecall(
			withDeclaredSettings({
				stores: { paths: { data: root }, settings: { get: async () => ({}) } },
			} as never),
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
    const result = await createRecall(
      withDeclaredSettings({
        stores: {
          paths: { data: root },
          settings: { get: async () => ({}) },
        },
      } as never),
    );
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
    expect(result.workers?.map((worker) => worker.name)).toEqual(["sittings"]);
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
        const result = await createRecall(
          withDeclaredSettings({
            stores: {
              paths: { data: root },
              settings: { get: async () => ({}) },
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
            embeddings: {
              list: async () => [{ model: "acme-embed/embed-1", provider: "acme-embed", dimensions: 2, local: false, default: true, status: "ready" }],
              // Never settles: one capture stays pending forever.
              embed: () => new Promise<never>(() => {}),
            },
          } as never),
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

  it("a transient model-list failure degrades search to lexical and a later call retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "recall-retry-"));
    // The store fails once: the factory's RAW read for the v4 migration label
    // is best effort and silent, so the extension still loads. Then the first
    // search call's model list degrades and the second succeeds — one logged
    // degradation, from the registry, never from the settings read.
    let failures = 1;
    let listFailures = 1;
    const result = await createRecall(
      withDeclaredSettings({
        stores: {
          paths: { data: root },
          settings: {
            get: async () => {
              if (failures > 0) {
                failures -= 1;
                throw new Error("store temporarily unavailable");
              }
              return {};
            },
          },
          secrets: { get: async () => undefined },
          user: () => ({ settings: { get: async () => ({}) } }),
        },
        conversations: {
          meta: async () => ({
            pinned: false,
            tagged: [],
            archived: false,
            draft: { text: "", attachments: [] },
            source: "test",
            owner: "alice",
          }),
          entry: async () => undefined,
        },
        embeddings: {
          list: async () => {
            if (listFailures > 0) {
              listFailures -= 1;
              throw new Error("the registry is still booting");
            }
            return [
              { model: "acme-embed/embed-1", provider: "acme-embed", dimensions: 2, local: false, default: true, status: "ready" },
            ];
          },
          embed: async (texts: readonly string[]) => ({
            ok: true,
            model: "acme-embed/embed-1",
            dimensions: 2,
            vectors: texts.map(() => new Float32Array([1])),
          }),
        },
      } as never),
    );
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const route = result.routes![0]!;
      const first = await route.handler(
        new Request("https://example.invalid/search?q=clinic"),
        { principal: { user: "alice", admin: false } } as never,
      );
      expect(first.status).toBe(200);
      const second = await route.handler(
        new Request("https://example.invalid/search?q=clinic"),
        { principal: { user: "alice", admin: false } } as never,
      );
      expect(second.status).toBe(200);
    } finally {
      console.error = originalError;
    }
    expect(errors).toHaveLength(1);
    await result.harnessShutdown?.({} as never, {} as never);
    await rm(root, { recursive: true, force: true });
  });
});

describe("the v4 migration label comes from the factory's settings read", () => {
  it("the factory hands the migration the label the old settings imply", async () => {
    const root = await mkdtemp(join(tmpdir(), "recall-label-"));
    const labels: (string | undefined)[] = [];
    try {
      const result = await createRecall(
        withDeclaredSettings({
          stores: {
            paths: { data: root },
            settings: {
              get: async () => ({
                embedding: {
                  url: "https://api.openai.com/v1",
                  model: "text-embedding-3-small",
                },
              }),
            },
            secrets: { get: async () => undefined },
          },
          conversations: {
            meta: async () => ({ owner: "alice" }),
          },
        } as never),
        {
          openDb: (path, labelModel) => {
            labels.push(labelModel);
            return RecallDb.open(path, labelModel);
          },
        },
      );
      // The database opens lazily, so drive one route to force it open.
      await result.routes![0]!.handler(
        new Request("https://example.invalid/search?q=clinic"),
        { principal: { user: "alice", admin: false } } as never,
      );
      expect(labels).toEqual(["openai/text-embedding-3-small"]);
      await result.harnessShutdown?.({} as never, {} as never);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("an unreadable settings store costs only the label, never the extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "recall-label-fail-"));
    const labels: (string | undefined)[] = [];
    try {
      const result = await createRecall(
        withDeclaredSettings({
          stores: {
            paths: { data: root },
            settings: {
              get: async () => {
                throw new Error("settings unreadable");
              },
            },
            secrets: { get: async () => undefined },
          },
          conversations: { meta: async () => ({ owner: "alice" }) },
        } as never),
        {
          openDb: (path, labelModel) => {
            labels.push(labelModel);
            return RecallDb.open(path, labelModel);
          },
        },
      );
      const response = await result.routes![0]!.handler(
        new Request("https://example.invalid/search?q=clinic"),
        { principal: { user: "alice", admin: false } } as never,
      );
      expect(response.status).toBe(200);
      expect(labels).toEqual([undefined]);
      await result.harnessShutdown?.({} as never, {} as never);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
