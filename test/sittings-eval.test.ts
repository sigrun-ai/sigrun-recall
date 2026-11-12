import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import { measureSittings } from "../scripts/sittings-eval.ts";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function user(text: string, timestamp: number): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistant(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "synthetic",
		model: "eval",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

describe("sittings eval", () => {
	it("measureSittings counts returns and shrinks them", () => {
		const messages: Message[] = [
			user("first sitting question ".repeat(20), T0),
			assistant("first sitting answer ".repeat(20), T0 + 1),
			user("first sitting follow-up ".repeat(20), T0 + 2),
			assistant("first sitting follow-up answer ".repeat(20), T0 + 3),
			user("second sitting question ".repeat(20), T0 + 61 * MIN),
			assistant("second sitting answer ".repeat(20), T0 + 61 * MIN + 1),
			user("second sitting follow-up ".repeat(20), T0 + 61 * MIN + 2),
			assistant("second sitting follow-up answer ".repeat(20), T0 + 61 * MIN + 3),
			user("third sitting question ".repeat(20), T0 + 122 * MIN),
		];

		const result = measureSittings(messages, { minGapMs: 60 * MIN, minHistoryTokens: 1 });

		expect(result.returns).toBe(2);
		expect(result.tokensWith).toHaveLength(2);
		expect(result.tokensWithout).toHaveLength(2);
		for (let index = 0; index < result.returns; index += 1) {
			expect(result.tokensWith[index]).toBeLessThan(result.tokensWithout[index]!);
		}
	});
});
