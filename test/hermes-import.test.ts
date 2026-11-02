import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { importChains } from "../scripts/hermes-import.js";

describe("Hermes import", () => {
	it("a metadata failure retries PATCH without posting the chain again", async () => {
		const root = await mkdtemp(join(tmpdir(), "hermes-import-retry-"));
		const state = join(root, "state.json");
		let posts = 0;
		let patches = 0;
		const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
			const url = String(input);
			if (url.endsWith("/import")) {
				posts += 1;
				return Response.json({ id: 7 });
			}
			patches += 1;
			if (patches === 1) return new Response("failed", { status: 500 });
			return Response.json({});
		});
		const chain = { root: { id: "root" }, name: "Synthetic", lines: ['{"kind":"pi.user","model":[]}'], bytes: 30 };
		await expect(importChains([chain], { baseUrl: "https://example.invalid", state }, "synthetic", fetchImpl)).rejects.toThrow();
		await importChains([chain], { baseUrl: "https://example.invalid", state }, "synthetic", fetchImpl);
		expect(posts).toBe(1);
		expect(patches).toBe(2);
		await rm(root, { recursive: true, force: true });
	});
});
