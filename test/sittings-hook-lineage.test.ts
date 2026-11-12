import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  EntryRecord,
  GenerationHooks,
  HookApi,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import createRecall from "../src/index.js";
import { withDeclaredSettings } from "./fake-host.js";

describe("recall beforeRequest lineage adapter", () => {
  it("passes ascending queries and limit/cursor/context in pi-durable order", async () => {
    const root = await mkdtemp(join(tmpdir(), "recall-lineage-hook-"));
    try {
      const result = await createRecall(
        withDeclaredSettings({
          stores: {
            paths: { data: root },
            settings: { get: async () => ({}) },
            user: () => ({ settings: { get: async () => ({}) } }),
          },
          users: { list: async () => [] },
          models: { isLocal: () => true },
          conversations: {
            meta: async () => ({ owner: "alice" }),
          },
        } as never),
      );
      const registration = result.extension?.hooks?.find(
        (entry) => "beforeRequest" in entry.handlers,
      );
      const beforeRequest = (
        registration!.handlers as Pick<GenerationHooks, "beforeRequest">
      ).beforeRequest;
      const calls: unknown[][] = [];
      const context = { name: "hook-context" };
      const api = {
        conversationId: 1,
        snapshot: async () => undefined,
        entries: async (...args: unknown[]) => {
          calls.push(args);
          // Empty: the lineage resolves to the own-conversation link and
          // the sittings step maps no user entry, so this pins the lineage
          // adapter alone.
          return { items: [] as EntryRecord[] };
        },
      };
      await beforeRequest(
        { messages: [{ role: "user", content: "question", timestamp: 1 }] },
        api as unknown as HookApi,
        context as never,
      );
      expect(calls).toEqual([
        // The sittings step loads the lineage (ascending), then maps the
        // newest user message to its entry (descending).
        [
          { order: "ascending", minEntryId: undefined, maxEntryId: undefined },
          200,
          undefined,
          context,
        ],
        [
          { order: "descending", minEntryId: undefined, maxEntryId: undefined },
          200,
          undefined,
          context,
        ],
      ]);
      await result.harnessShutdown?.({} as never, {} as never);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("internal conversations never read lineage entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "recall-lineage-internal-"));
    try {
      const result = await createRecall(
        withDeclaredSettings({
          stores: {
            paths: { data: root },
            settings: { get: async () => ({}) },
            user: () => ({ settings: { get: async () => ({}) } }),
          },
          users: { list: async () => [] },
          models: { isLocal: () => true },
          conversations: {
            meta: async () => ({ owner: "alice", internal: true }),
          },
        } as never),
      );
      const registration = result.extension?.hooks?.find(
        (entry) => "beforeRequest" in entry.handlers,
      );
      const beforeRequest = (
        registration!.handlers as Pick<GenerationHooks, "beforeRequest">
      ).beforeRequest;
      let reads = 0;
      const api = {
        conversationId: 1,
        snapshot: async () => undefined,
        entries: async () => {
          reads += 1;
          throw new Error("internal lineage read");
        },
      };
      expect(
        await beforeRequest(
          { messages: [{ role: "user", content: "question", timestamp: 1 }] },
          api as unknown as HookApi,
          {} as never,
        ),
      ).toBeUndefined();
      expect(reads).toBe(0);
      await result.harnessShutdown?.({} as never, {} as never);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
