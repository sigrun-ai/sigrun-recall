import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import createRecall from "../src/index.js";

describe("createRecall", () => {
	it("factory.length === 1", () => {
		expect(createRecall.length).toBe(1);
	});

	it("factory result declares the backfill job, both tools, both hooks and both routes", async () => {
		const root = await mkdtemp(join(tmpdir(), "recall-index-"));
		const result = createRecall({
			stores: {
				paths: { data: root },
				settings: { get: async () => ({}) },
			},
		} as never);
		expect(result.jobs).toEqual([
			expect.objectContaining({ name: "backfill", schedule: { cron: "*/10 * * * *" } }),
		]);
		expect(result.extension?.tools?.map((tool) => tool.name)).toEqual(["recall_search", "recall_open"]);
		expect(result.extension?.hooks).toHaveLength(2);
		expect(result.routes?.map((route) => `${route.method} ${route.path}`)).toEqual([
			"GET search",
			"POST backfill",
		]);
		await rm(root, { recursive: true, force: true });
	});
});
