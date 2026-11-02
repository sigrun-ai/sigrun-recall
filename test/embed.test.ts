import { afterEach, describe, expect, it, vi } from "vitest";

import { createEmbedder } from "../src/embed.js";
import { createVectorArm, createSqliteVectorIndex } from "../src/vectors.js";
import { RecallDb } from "../src/db.js";

const openDatabases: RecallDb[] = [];
afterEach(() => {
	for (const db of openDatabases.splice(0)) db.close();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("embed", () => {
	it("createEmbedder sends model and input and parses data[].embedding", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
			expect(JSON.parse(String(init?.body))).toEqual({ model: "embed-model", input: ["one", "two"] });
			expect(init?.headers).toEqual({
				"content-type": "application/json",
				authorization: "Bearer synthetic-key",
			});
			return new Response(
				JSON.stringify({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] }),
				{ status: 200 },
			);
		});
		const embedder = createEmbedder(
			{ url: "https://example.invalid/embed", model: "embed-model", local: false },
			async () => "synthetic-key",
			fetchImpl,
		);
		const vectors = await embedder.embed(["one", "two"]);
		expect(fetchImpl).toHaveBeenCalledWith(
			"https://example.invalid/embed/embeddings",
			expect.objectContaining({ method: "POST" }),
		);
		expect(vectors.map((vector) => [...vector])).toEqual([[1, 0], [0, 1]]);
		expect(embedder.local).toBe(false);
	});

	it("the vector arm returns [] when the embedder exceeds the 800 ms timeout", async () => {
		vi.useFakeTimers();
		const embedder = createEmbedder(
			{ url: "https://example.invalid/embed", model: "embed-model", local: false },
			async () => undefined,
			(_url, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				}),
		);
		const db = RecallDb.open(":memory:");
		openDatabases.push(db);
		const arm = createVectorArm(embedder, createSqliteVectorIndex(db), 800);
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const result = arm.query("semantic", 10);
		await vi.advanceTimersByTimeAsync(800);
		expect(await result).toEqual([]);
		expect(warning).toHaveBeenCalled();
	});

	it("the paged cosine scan returns the nearest itemIds and never reads more than pageSize rows per page", () => {
		const db = RecallDb.open(":memory:");
		openDatabases.push(db);
		const index = createSqliteVectorIndex(db, 2);
		index.upsert(1, new Float32Array([1, 0]));
		index.upsert(2, new Float32Array([0, 1]));
		index.upsert(3, new Float32Array([1, 1]));
		const read = vi.spyOn(db, "listVectorsPage");
		expect(index.query(new Float32Array([1, 0]), 2)).toEqual([
			{ itemId: 1, score: 1 },
			{ itemId: 3, score: 1 / Math.sqrt(2) },
		]);
		expect(read).toHaveBeenCalled();
		for (const call of read.mock.calls) expect(call[1]).toBeLessThanOrEqual(2);
	});

	it("an aborted signal stops the scan between pages and returns the partial best", () => {
		const db = RecallDb.open(":memory:");
		openDatabases.push(db);
		const index = createSqliteVectorIndex(db, 1);
		index.upsert(1, new Float32Array([1, 0]));
		index.upsert(2, new Float32Array([0, 1]));
		const controller = new AbortController();
		const read = vi.spyOn(db, "listVectorsPage").mockImplementation(() => {
			controller.abort();
			return [{ itemId: 1, vec: Buffer.from(new Float32Array([1, 0]).buffer) }];
		});
		expect(index.query(new Float32Array([1, 0]), 2, controller.signal)).toEqual([
			{ itemId: 1, score: 1 },
		]);
		expect(read).toHaveBeenCalledTimes(1);
	});
});
