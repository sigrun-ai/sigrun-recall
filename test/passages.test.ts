import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { passagesOf } from "../src/passages.js";

function entry(model: EntryRecord["model"]): EntryRecord {
	return { id: 7, conversationId: 1, kind: "pi.message", model } as unknown as EntryRecord;
}

function assistant(content: unknown[], timestamp: number): EntryRecord["model"] {
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
		const passages = passagesOf(entry(assistant([{ type: "text", text }], 1234)));

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
		expect(passages.map((passage) => passage.length)).toEqual([1502, 1502, 1496]);
		expect(passages.map((passage) => passage.at)).toEqual([1234, 1234, 1234]);
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
				kind: "tool",
				offset: 0,
				length: 45,
				text: 'web_fetch {"url":"https://example.invalid/a"}',
				at: 1234,
			},
		]);
	});
});
