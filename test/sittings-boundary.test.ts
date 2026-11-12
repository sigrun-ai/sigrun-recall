import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
  estimateTokens,
  gapMs,
  isBoundary,
  type SittingOptions,
} from "../src/sittings/boundary.js";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function user(text: string, timestamp = T0): UserMessage {
  return { role: "user", content: text, timestamp };
}

function options(minHistoryTokens: number): SittingOptions {
  return { minGapMs: 60 * MIN, minHistoryTokens };
}

describe("sitting boundaries", () => {
  it("no boundary for the first message", () => {
    expect(isBoundary([user("first")], 0, 0, options(0))).toBe(false);
  });

  it("no boundary under the gap", () => {
    const messages = [
      user("h".repeat(35_998), T0),
      user("new question", T0 + 59 * MIN),
    ];
    expect(isBoundary(messages, 1, 0, options(9_000))).toBe(false);
  });

  it("boundary over the gap with enough history", () => {
    const messages = [
      user("h".repeat(35_998), T0),
      user("new question", T0 + 61 * MIN),
    ];
    expect(isBoundary(messages, 1, 0, options(9_000))).toBe(true);
  });

  it("no boundary at exactly the minimum gap", () => {
    const messages = [
      user("h".repeat(35_998), T0),
      user("new question", T0 + 60 * MIN),
    ];
    expect(isBoundary(messages, 1, 0, options(9_000))).toBe(false);
  });

  it("excludes system messages from the gap check", () => {
    const messages: Message[] = [
      { role: "system", content: "initial prompt", timestamp: T0 },
      user("h".repeat(35_998), T0),
      { role: "system", content: "later prompt", timestamp: T0 + 60 * MIN },
      user("new question", T0 + 61 * MIN),
    ];
    expect(isBoundary(messages, 3, 0, options(9_000))).toBe(true);
  });

  it("no boundary over the gap with little history", () => {
    const messages = [
      user("h".repeat(1_998), T0),
      user("new question", T0 + 61 * MIN),
    ];
    expect(isBoundary(messages, 1, 0, options(9_000))).toBe(false);
  });

  it("estimates tokens from the combined UTF-8 JSON content bytes", () => {
    const messages: Message[] = [
      user("a"),
      user("a"),
      user("a"),
      user("a"),
      user("é"),
    ];
    // Four 3-byte strings and one 4-byte string: ceil(16 / 4) = 4.
    expect(estimateTokens(messages)).toBe(4);
  });

  it("gapMs takes the larger of the setting and a declared cache lifetime", () => {
    expect(gapMs(60, { promptCache: { long: 7_200 } })).toBe(7_200_000);
    expect(gapMs(60, { promptCache: { short: 300 } })).toBe(3_600_000);
    expect(gapMs(60, undefined)).toBe(3_600_000);
  });
});
