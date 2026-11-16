import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { passagesOf } from "../src/passages.js";

function entry(model: EntryRecord["model"]): EntryRecord {
  return {
    id: 7,
    conversationId: 1,
    kind: "pi.message",
    model,
  } as unknown as EntryRecord;
}

function attachmentEntry(
  content: unknown[],
  attachments: unknown[],
): EntryRecord {
  return {
    ...entry([
      {
        role: "user",
        content,
        timestamp: 1234,
      },
    ] as EntryRecord["model"]),
    kind: "sigrun.user",
    data: { attachments },
  } as EntryRecord;
}

function attachment(parts: number[], delivery = "inline"): unknown {
  return {
    path: "uploads/7/a.md",
    name: "a.md",
    mime: delivery === "image" ? "image/png" : "text/markdown",
    bytes: 10 * 1024,
    delivery,
    parts,
  };
}

function assistant(
  content: unknown[],
  timestamp: number,
): EntryRecord["model"] {
  return [
    {
      role: "assistant",
      content,
      timestamp,
      api: "openai-completions",
      provider: "acme-local",
      model: "test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
    },
  ] as EntryRecord["model"];
}

describe("passagesOf", () => {
  it("passagesOf splits a 4500-char assistant text into three passages at paragraph boundaries, each ≤ 2000 chars, offsets contiguous", () => {
    const paragraphs = ["a".repeat(1500), "b".repeat(1500), "c".repeat(1496)];
    const text = paragraphs.join("\n\n");
    const passages = passagesOf(
      entry(assistant([{ type: "text", text }], 1234)),
    );

    expect(passages).toHaveLength(3);
    expect(passages.every((passage) => passage.length <= 2000)).toBe(true);
    expect(passages.map((passage) => passage.text)).toEqual([
      `${paragraphs[0]}\n\n`,
      `${paragraphs[1]}\n\n`,
      paragraphs[2],
    ]);
    expect(text.slice(1502, 1502 + 1502)).toBe(passages[1]?.text);
    expect(text.slice(3004)).toBe(passages[2]?.text);
    expect(passages.map((passage) => passage.offset)).toEqual([0, 1502, 3004]);
    expect(passages.map((passage) => passage.length)).toEqual([
      1502, 1502, 1496,
    ]);
    expect(passages.map((passage) => passage.at)).toEqual([1234, 1234, 1234]);
  });

  it("indexes distinct text blocks in one message", () => {
    const passages = passagesOf(
      entry([
        {
          role: "user",
          content: [
            { type: "text", text: "first block" },
            { type: "text", text: "second block" },
          ],
          timestamp: 1234,
        },
      ]),
    );
    expect(passages.map((passage) => passage.text)).toEqual(["first block", "second block"]);
    expect(passages.map((passage) => passage.blockIndex)).toEqual([0, 1]);
  });

  it("indexes an inline attachment's marker and typed text, not its 10 KB body", () => {
    const body = `private attachment body ${"x".repeat(10 * 1024)}`;
    const marker = '<attachment path="uploads/7/a.md" type="text/markdown" size="10.0 KB">';
    const passages = passagesOf(
      attachmentEntry(
        [
          { type: "text", text: `${marker}\n${body}\n</attachment>` },
          { type: "text", text: "summarise the attached note" },
        ],
        [attachment([0])],
      ),
    );

    expect(passages.map((passage) => passage.text)).toEqual([
      marker,
      "summarise the attached note",
    ]);
    expect(
      passages.map(({ messageIndex, blockIndex, offset }) => ({
        messageIndex,
        blockIndex,
        offset,
      })),
    ).toEqual([
      { messageIndex: 0, blockIndex: 0, offset: 0 },
      { messageIndex: 0, blockIndex: 1, offset: 0 },
    ]);
    expect(passages.some((passage) => passage.text.includes(body))).toBe(false);
  });

  it("indexes an image attachment's marker without indexing the image", () => {
    const marker =
      '<attachment path="uploads/7/a.md" type="image/png" size="10.0 KB" delivery="image"/>';
    const passages = passagesOf(
      attachmentEntry(
        [
          { type: "text", text: "inspect the attached chart" },
          { type: "text", text: marker },
          { type: "image", data: "c3ludGhldGljLWJhc2U2NA==", mimeType: "image/png" },
        ],
        [attachment([1, 2], "image")],
      ),
    );

    expect(passages.map((passage) => passage.text)).toEqual([
      "inspect the attached chart",
      marker,
    ]);
    expect(passages.map((passage) => passage.blockIndex)).toEqual([0, 1]);
    expect(passages[1]?.offset).toBe(0);
  });

  it("derives identical attachment passage triples on every call", () => {
    const record = attachmentEntry(
      [
        {
          type: "text",
          text: '<attachment path="uploads/7/a.md" type="text/markdown" size="10.0 KB">\nbody\n</attachment>',
        },
        { type: "text", text: "what does the note say?" },
      ],
      [attachment([0])],
    );
    const triples = () =>
      passagesOf(record).map(({ messageIndex, blockIndex, offset }) => ({
        messageIndex,
        blockIndex,
        offset,
      }));

    expect(triples()).toEqual(triples());
    expect(triples()).toEqual([
      { messageIndex: 0, blockIndex: 0, offset: 0 },
      { messageIndex: 0, blockIndex: 1, offset: 0 },
    ]);
  });

  it("ignores attachment-shaped data on pi.user entries", () => {
    const marker = '<attachment path="uploads/7/a.md" type="text/markdown" size="10.0 KB">';
    const inline = `${marker}\nplain user body\n</attachment>`;
    const record = {
      ...attachmentEntry([{ type: "text", text: inline }], [attachment([0])]),
      kind: "pi.user",
    } as EntryRecord;

    expect(passagesOf(record).map((passage) => passage.text)).toEqual([inline]);
  });

  it('passagesOf skips thinking and renders a tool call as "web_fetch {"url":"https://example.invalid/a"}"', () => {
    const passages = passagesOf(
      entry(
        assistant(
          [
            { type: "thinking", thinking: "hidden" },
            {
              type: "toolCall",
              id: "call-1",
              name: "web_fetch",
              arguments: { url: "https://example.invalid/a" },
            },
          ],
          1234,
        ),
      ),
    );

    expect(passages).toEqual([
      {
        entryId: 7,
        messageIndex: 0,
        blockIndex: 1,
        kind: "tool",
        offset: 0,
        length: 45,
        text: 'web_fetch {"url":"https://example.invalid/a"}',
        at: 1234,
      },
    ]);
  });
});
