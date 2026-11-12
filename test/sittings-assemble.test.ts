import type {
  AssistantMessage,
  ImageContent,
  Message,
  UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  assembleSitting,
  previousExchange,
} from "../src/sittings/assemble.js";
import type { PreviousExchange } from "../src/sittings/types.js";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function user(
  content: UserMessage["content"],
  timestamp = T0,
): UserMessage {
  return { role: "user", content, timestamp };
}

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
  timestamp = T0 + 1,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "acme-local",
    model: "chat-1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp,
  };
}

function system(timestamp: number): Message {
  return { role: "system", content: "system prompt", timestamp };
}

describe("previous exchanges", () => {
  it("skips an unanswered last user message", () => {
    const u1 = user("first question");
    const a1 = assistant([{ type: "text", text: "A1" }]);
    const u2 = user("unanswered question", T0 + 2 * MIN);
    const messages: Message[] = [u1, a1, u2];

    expect(previousExchange(messages, 2)).toEqual({
      user: { ...u1, content: [{ type: "text", text: "first question" }] },
      assistant: a1,
    });
  });

  it("drops thinking and tool calls from the assistant", () => {
    const u1 = user("question");
    const a1 = assistant([
      { type: "thinking", thinking: "private reasoning" },
      { type: "text", text: "visible answer" },
      { type: "toolCall", id: "call-1", name: "search", arguments: {} },
      { type: "text", text: "after the tool" },
    ]);
    const result = previousExchange([u1, a1], 2);

    expect(result?.assistant.content).toEqual([
      { type: "text", text: "visible answer" },
      { type: "text", text: "after the tool" },
    ]);
  });
});

describe("sitting assembly", () => {
  it("keeps system messages and drops pre-boundary turns", () => {
    const previous: PreviousExchange = {
      user: user([{ type: "text", text: "earlier question" }]),
      assistant: assistant([{ type: "text", text: "earlier answer" }]),
    };
    const messages: Message[] = [
      system(T0),
      user("old question", T0 + 1),
      assistant([{ type: "text", text: "old answer" }], "stop", T0 + 2),
      system(T0 + 3),
      user("boundary question", T0 + 61 * MIN),
      assistant([{ type: "text", text: "new answer" }], "stop", T0 + 62 * MIN),
    ];
    const result = assembleSitting(messages, {
      boundaryAt: T0 + 60 * MIN,
      previous,
      blockText: "recall block",
    });

    expect(result.map(({ role }) => role)).toEqual([
      "system",
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(result[0]).toBe(messages[0]);
    expect(result[1]).toBe(messages[3]);
    expect(result[2]).toBe(previous.user);
    expect(result[3]).toBe(previous.assistant);
    expect(result[4]).not.toBe(messages[4]);
    expect(result[5]).toBe(messages[5]);
    expect(messages).toHaveLength(6);
    expect(messages[4]?.content).toBe("boundary question");
  });

  it("with no previous exchange never starts with an unanswered pre-boundary user message", () => {
    const messages: Message[] = [
      user("unanswered old question", T0),
      user("boundary question", T0 + 61 * MIN),
    ];
    const originalContent = messages[1]?.content;
    const result = assembleSitting(messages, {
      boundaryAt: T0 + 60 * MIN,
      blockText: "recall block",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ role: "user" });
    expect(result[0]?.content).toEqual([
      { type: "text", text: "recall block" },
      { type: "text", text: "boundary question" },
    ]);
    expect(messages[1]?.content).toBe(originalContent);
  });

  it("the block is the first part of the boundary message and image parts survive", () => {
    const image: ImageContent = {
      type: "image",
      data: "aW1hZ2U=",
      mimeType: "image/png",
    };
    const messages: Message[] = [
      user([{ type: "text", text: "look at this" }, image], T0 + 61 * MIN),
    ];
    const originalContent = messages[0]?.content;
    const result = assembleSitting(messages, {
      boundaryAt: T0 + 60 * MIN,
      blockText: "recall block",
    });

    expect(result[0]?.content).toEqual([
      { type: "text", text: "recall block" },
      { type: "text", text: "look at this" },
      image,
    ]);
    expect(messages[0]?.content).toBe(originalContent);
  });

  it("after an in-sitting compaction the block attaches to the compaction summary", () => {
    const previous: PreviousExchange = {
      user: user([{ type: "text", text: "before compaction" }]),
      assistant: assistant([{ type: "text", text: "answer before compaction" }]),
    };
    const messages: Message[] = [
      system(T0),
      user("Compaction summary: earlier work", T0 + 60 * MIN),
      assistant([{ type: "text", text: "continuing" }], "stop", T0 + 61 * MIN),
    ];
    const result = assembleSitting(messages, {
      boundaryAt: T0 + 60 * MIN,
      previous,
      blockText: "recall block",
    });

    expect(result.map(({ role }) => role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(result[3]?.content).toEqual([
      { type: "text", text: "recall block" },
      { type: "text", text: "Compaction summary: earlier work" },
    ]);
  });
});
