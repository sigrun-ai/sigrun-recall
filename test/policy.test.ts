import { describe, expect, it } from "vitest";

import { mayRead } from "../src/policy.js";

const cases: {
	name: string;
	cls: Parameters<typeof mayRead>[0];
	model: { provider: string; id: string } | undefined;
	isLocal: (model: string) => boolean;
	expected: boolean;
}[] = [
	{
		name: "local-only material cannot reach an undefined model",
		cls: "local-only",
		model: undefined,
		isLocal: () => true,
		expected: false,
	},
	{
		name: "local-only material cannot reach a non-local model",
		cls: "local-only",
		model: { provider: "acme-cloud", id: "chat-1" },
		isLocal: (model) => model === "acme-local/chat-1",
		expected: false,
	},
	{
		name: "local-only material reaches the admin-switched local model",
		cls: "local-only",
		model: { provider: "acme-local", id: "chat-1" },
		isLocal: (model) => model === "acme-local/chat-1",
		expected: true,
	},
	{
		name: "unknown confidentiality fails closed as local-only",
		cls: "future-private" as Parameters<typeof mayRead>[0],
		model: { provider: "acme-cloud", id: "chat-1" },
		isLocal: () => false,
		expected: false,
	},
	{
		name: "normal material needs no model or locality switch",
		cls: "normal",
		model: undefined,
		isLocal: () => false,
		expected: true,
	},
];

describe("mayRead", () => {
	it.each(cases)("$name", ({ cls, model, isLocal, expected }) => {
		expect(mayRead(cls, model, isLocal)).toBe(expected);
	});

	it("checks the full provider/model id, not just the provider", () => {
		const calls: string[] = [];
		expect(
			mayRead(
				"local-only",
				{ provider: "acme-local", id: "chat-1" },
				(model) => {
					calls.push(model);
					return model === "acme-local/chat-1";
				},
			),
		).toBe(true);
		expect(calls).toEqual(["acme-local/chat-1"]);
	});
});
