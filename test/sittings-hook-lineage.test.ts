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
          return {
            items: [
              {
                id: 1,
                conversationId: 1,
                kind: "pi.message",
                model: [{ role: "user", content: "question", timestamp: 1 }],
              },
            ] as unknown as EntryRecord[],
          };
        },
      };
      await beforeRequest(
        { messages: [{ role: "user", content: "question", timestamp: 1 }] },
        api as unknown as HookApi,
        context as never,
      );
      expect(calls).toEqual([
        [
          { order: "ascending" },
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
});
