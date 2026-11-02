import type { Sharing } from "@sigrun/shared/access";
import { describe, expect, it } from "vitest";

import { audienceCovers } from "../src/audience.js";

interface ConversationAccess {
	owner?: string;
	sharing?: Sharing;
}

const cases: {
	name: string;
	current: ConversationAccess;
	item: ConversationAccess;
	expected: boolean;
}[] = [
	{
		name: "private alice current: alice's private item is covered",
		current: { owner: "alice" },
		item: { owner: "alice", sharing: { scope: "private" } },
		expected: true,
	},
	{
		name: "private alice current: bob's private item is not covered",
		current: { owner: "alice" },
		item: { owner: "bob", sharing: { scope: "private" } },
		expected: false,
	},
	{
		name: "private alice current: bob's item shared with alice is covered",
		current: { owner: "alice" },
		item: {
			owner: "bob",
			sharing: { scope: "people", users: ["alice"], level: "read" },
		},
		expected: true,
	},
	{
		name: "alice's conversation shared with bob: alice's private item is not covered",
		current: {
			owner: "alice",
			sharing: { scope: "people", users: ["bob"], level: "read" },
		},
		item: { owner: "alice", sharing: { scope: "private" } },
		expected: false,
	},
	{
		name: "alice's conversation shared with bob: a household item is covered",
		current: {
			owner: "alice",
			sharing: { scope: "people", users: ["bob"], level: "read" },
		},
		item: { owner: "alice", sharing: { scope: "household", level: "read" } },
		expected: true,
	},
	{
		name: "alice's conversation shared with bob: an item shared with both is covered",
		current: {
			owner: "alice",
			sharing: { scope: "people", users: ["bob"], level: "read" },
		},
		item: {
			owner: "bob",
			sharing: { scope: "people", users: ["alice", "bob"], level: "read" },
		},
		expected: true,
	},
	{
		name: "household current: alice's private item is not covered",
		current: { owner: "bob", sharing: { scope: "household", level: "read" } },
		item: { owner: "alice", sharing: { scope: "private" } },
		expected: false,
	},
	{
		name: "household current: a household item is covered",
		current: { owner: "bob", sharing: { scope: "household", level: "read" } },
		item: { owner: "alice", sharing: { scope: "household", level: "read" } },
		expected: true,
	},
	{
		name: "group sharing: an item shared with the same group is covered",
		current: {
			sharing: { scope: "people", users: [], groups: ["family"], level: "read" },
		},
		item: {
			owner: "bob",
			sharing: { scope: "people", users: [], groups: ["family"], level: "read" },
		},
		expected: true,
	},
	{
		name: "group sharing: an item shared only with alice is not covered",
		current: {
			owner: "alice",
			sharing: { scope: "people", users: [], groups: ["family"], level: "read" },
		},
		item: {
			owner: "bob",
			sharing: { scope: "people", users: ["alice"], level: "read" },
		},
		expected: false,
	},
	{
		name: "an ownerless item is covered by every current",
		current: { owner: "alice", sharing: { scope: "private" } },
		item: {},
		expected: true,
	},
	{
		name: "an ownerless current requires an ownerless or household item",
		current: {},
		item: { owner: "alice", sharing: { scope: "private" } },
		expected: false,
	},
	{
		name: "an absent sharing grant is private",
		current: { owner: "alice" },
		item: { owner: "bob" },
		expected: false,
	},
];

describe("audienceCovers", () => {
	it.each(cases)("$name", ({ name, current, item, expected }) => {
		expect(audienceCovers(current, item), `${name}: ${JSON.stringify({ current, item })}`).toBe(expected);
	});
});
