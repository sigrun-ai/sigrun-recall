import { describe, expect, it, vi } from "vitest";

import {
	legacyEmbeddingSettings,
	migrationLabel,
	resolveSettings,
	resolveUserSettings,
	type SettingsReader,
} from "../src/config.js";
import { embeddingsMovedNotice, primaryAdmin } from "../src/notice.js";

function settingsReader(values: Record<string, unknown>): SettingsReader {
	return { get: async () => values };
}

describe("settings", () => {
	it("resolveSettings fills defaults: externalizeBytes 24576 and nothing else", async () => {
		expect(await resolveSettings(settingsReader({}))).toEqual({
			externalizeBytes: 24_576,
		});
	});

	it("the dead embedding block is not parsed into settings at all", async () => {
		// The block survives on disk until the operator deletes it; recall
		// must not resurrect it as behaviour.
		expect(
			await resolveSettings(
				settingsReader({
					embedding: { url: "https://example.invalid/v1", model: "m", timeoutMs: 5 },
				}),
			),
		).toEqual({ externalizeBytes: 24_576 });
	});

	it('resolveUserSettings({autoRecall: "yes"}) warns once and returns autoRecall true', async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(
				await resolveUserSettings(settingsReader({ autoRecall: "yes" })),
			).toEqual({ autoRecall: true, localProviders: [] });
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});

describe("migration label", () => {
	it("labels the old model only for OpenAI's own endpoint", () => {
		expect(
			migrationLabel({
				embedding: { url: "https://api.openai.com/v1", model: "text-embedding-3-small" },
			}),
		).toBe("openai/text-embedding-3-small");
		// Any other endpoint might have served a different model under that name.
		expect(
			migrationLabel({
				embedding: { url: "https://example.invalid/v1", model: "text-embedding-3-small" },
			}),
		).toBeUndefined();
		expect(migrationLabel({ embedding: { url: "https://api.openai.com/v1" } })).toBeUndefined();
		expect(migrationLabel({ embedding: { url: "not a url", model: "m" } })).toBeUndefined();
		expect(migrationLabel({})).toBeUndefined();
	});
});

describe("the embeddings-moved notice", () => {
	it("primaryAdmin is the first admin in directory order, never a non-admin", () => {
		expect(
			primaryAdmin([
				{ user: "bob", admin: false },
				{ user: "alice", admin: true },
				{ user: "carol", admin: true },
			]),
		).toBe("alice");
		// A directory with no admin has nobody the notice is for.
		expect(primaryAdmin([{ user: "bob", admin: false }])).toBeUndefined();
		// An empty (unclaimed) directory has no recipient either.
		expect(primaryAdmin([])).toBeUndefined();
	});

	it("is silent without the old embedding block", () => {
		expect(embeddingsMovedNotice({})).toBeUndefined();
		expect(embeddingsMovedNotice({ embedding: { url: "https://example.invalid/v1" } })).toBeUndefined();
	});

	it("names the old model and says labelled vectors were kept", () => {
		const notice = embeddingsMovedNotice({
			embedding: { url: "https://api.openai.com/v1", model: "text-embedding-3-small" },
		})!;
		expect(notice.kind).toBe("recall.embeddings-moved");
		expect(notice.title).toBe("Recall embeddings now come from a provider");
		expect(notice.body).toContain("text-embedding-3-small");
		expect(notice.body).toContain("openai/text-embedding-3-small");
		expect(notice.body).toContain("kept");
		expect(notice.body).not.toContain("re-embedded");
		expect(notice.body).toContain("embeddingModel");
		expect(notice.body).toContain("OPENAI_API_KEY");
		expect(notice.body.length).toBeLessThanOrEqual(2000);
	});

	it("bounds an operator-supplied model and endpoint to the body cap", () => {
		// `notify` rejects a body over 2000 characters, which would lose the
		// notice for good, so the interpolated config is clamped.
		const notice = embeddingsMovedNotice({
			embedding: { url: "https://example.invalid/" + "u".repeat(5000), model: "m".repeat(5000) },
		})!;
		expect(notice.body.length).toBeLessThanOrEqual(2000);
		expect(notice.body).toContain("embeddingModel");
	});

	it("says unlabelled vectors are re-embedded", () => {
		const notice = embeddingsMovedNotice({
			embedding: { url: "https://example.invalid/v1", model: "embed-model" },
		})!;
		expect(notice.body).toContain("embed-model");
		expect(notice.body).toContain("re-embedded");
		expect(notice.body).not.toContain("were kept");
		expect(notice.body).toContain("embeddingModel");
		expect(notice.body.length).toBeLessThanOrEqual(2000);
	});
});
