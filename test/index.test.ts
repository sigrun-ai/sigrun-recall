import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import createRecall from "../src/index.js";
import { RecallDb } from "../src/db.js";

describe("createRecall", () => {
  it("factory.length === 1", () => {
    expect(createRecall.length).toBe(1);
  });

  it("defers the database until use and closes it at harness shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "recall-lifecycle-"));
		let opened = 0;
		const result = createRecall(
			{ stores: { paths: { data: root }, settings: { get: async () => ({}) } } } as never,
			{
				openDb: (path) => {
					opened += 1;
					return RecallDb.open(path);
				},
			},
		);
    expect(opened).toBe(0);
		expect(result.routes).toHaveLength(2);
		expect(opened).toBe(0);
		await result.routes![0]!.handler(new Request("https://example.invalid/search?q=empty"), {
			principal: { user: "alice", admin: false },
		} as never);
		expect(opened).toBe(1);
    await result.harnessShutdown?.({} as never, {} as never);
    await rm(root, { recursive: true, force: true });
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
      expect.objectContaining({
        name: "backfill",
        schedule: { cron: "*/10 * * * *" },
      }),
    ]);
    expect(result.extension?.tools?.map((tool) => tool.name)).toEqual([
      "recall_search",
      "recall_open",
    ]);
    expect(
      result.extension?.tasks?.map((task) => task.definition.name),
    ).toEqual(["recall.backfill"]);
    expect(result.extension?.hooks).toHaveLength(2);
    expect(
      result.routes?.map((route) => `${route.method} ${route.path}`),
    ).toEqual(["GET search", "POST backfill"]);
    await rm(root, { recursive: true, force: true });
  });
});
