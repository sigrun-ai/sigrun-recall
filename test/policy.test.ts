import { describe, expect, it } from "vitest";

import { mayRead } from "../src/policy.js";

const cases: {
	name: string;
	cls: "normal" | "local-only";
	model: { provider: string } | undefined;
	itemOwnerLocalProviders: readonly string[];
	expected: boolean;
}[] = [
	{
		name: "local-only material cannot reach an undefined model",
		cls: "local-only",
		model: undefined,
		itemOwnerLocalProviders: ["acme-local"],
		expected: false,
	},
	{
		name: "local-only material cannot reach a cloud provider",
		cls: "local-only",
		model: { provider: "acme-cloud" },
		itemOwnerLocalProviders: ["acme-local"],
		expected: false,
	},
	{
		name: "local-only material can reach the owner's local provider",
		cls: "local-only",
		model: { provider: "acme-local" },
		itemOwnerLocalProviders: ["acme-local"],
		expected: true,
	},
	{
		name: "normal material needs no model or provider allowlist",
		cls: "normal",
		model: undefined,
		itemOwnerLocalProviders: [],
		expected: true,
	},
];

describe("mayRead", () => {
	it.each(cases)("$name", ({ cls, model, itemOwnerLocalProviders, expected }) => {
		expect(mayRead(cls, model, itemOwnerLocalProviders)).toBe(expected);
	});
});
