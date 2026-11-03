import { describe, expect, it } from "vitest";

import { evaluatePairs } from "../scripts/recall-eval.js";

describe("recall eval", () => {
	it("recall-eval computes hit@5 and MRR from a fake route", () => {
		const result = evaluatePairs(
			[
				{ query: "first", expect: 101 },
				{ query: "second", expect: 202 },
				{ query: "missing", expect: 303 },
			],
			[
				[{ conversationId: 101 }],
				[{ conversationId: 999 }, { conversationId: 998 }, { conversationId: 202 }],
				[{ conversationId: 999 }],
			],
			5,
		);
		expect(result.ranks).toEqual([1, 3, 0]);
		expect(result.hitAtK).toBe(2 / 3);
		expect(result.mrr).toBeCloseTo((1 + 1 / 3) / 3);
	});

	it("drops excluded conversation hits before ranking", () => {
		const result = evaluatePairs(
			[{ query: "later opening", expect: 202, exclude: 101 }],
			[[
				{ conversationId: 101 },
				{ conversationId: 202 },
				{ conversationId: 303 },
			]],
			5,
		);
		expect(result.ranks).toEqual([1]);
		expect(result.hitAtK).toBe(1);
		expect(result.mrr).toBe(1);
	});
});
