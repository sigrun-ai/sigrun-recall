import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { ToolExecutionResult, ToolHookCall } from "@earendil-works/pi-durable";

import createRecall from "../src/index.js";
import { withDeclaredSettings } from "./fake-host.js";

/**
 * pi-durable 1.5.0 hook gating (spec §3.2-b): the harness runs afterTool
 * on results it wrote for calls that never executed — those must never
 * be externalized into the artifact store.
 */
describe("recall afterTool on a harness-written result", () => {
  it("error results the harness wrote are not externalized", async () => {
    const root = await mkdtemp(join(tmpdir(), "recall-gating-"));
    try {
      const result = await createRecall(
        withDeclaredSettings({
          stores: {
            paths: { data: root },
            settings: { get: async () => ({ externalizeBytes: 1 }) },
          },
          conversations: {
            meta: async () => ({ owner: "alice" }),
          },
        } as never),
      );
      const registration = (result.extension?.hooks ?? []).find(
        (entry) => "afterTool" in entry.handlers,
      );
      expect(registration).toBeDefined();
      const afterTool = (
        registration!.handlers as {
          afterTool: (
            call: ToolHookCall,
            result: ToolExecutionResult,
            api: { conversationId: number },
          ) => Promise<ToolExecutionResult | undefined>;
        }
      ).afterTool;
      const call = {
        type: "toolCall",
        id: "call-1",
        name: "web_fetch",
        arguments: { url: "https://example.invalid/page" },
      } as ToolHookCall;
      // A harness-written result may not be error-flagged; the
      // diagnostic code is the only signal the call never ran. The
      // output is above threshold so externalize() WOULD fire if it
      // ever saw it.
      const unavailable: ToolExecutionResult = {
        output: [{ type: "text", text: "x".repeat(30_000) }],
        diagnostics: [
          { severity: "error", message: "no such tool", code: "tool_unavailable" },
        ],
      };
      expect(await afterTool(call, unavailable, { conversationId: 1 })).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
