/**
 * The dead `embedding` settings group, read off the raw settings file for
 * the two migration concerns only (the v4 vector label and the
 * one-per-boot "embeddings moved to a provider" notice). The settings that
 * DRIVE behaviour are declared in `src/settings-schema.ts` and covered by
 * `test/settings-schema.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
	legacyEmbeddingSettings,
	migrationLabel,
} from "../src/legacy-embedding.js";
import { embeddingsMovedNotice, primaryAdmin } from "../src/notice.js";

describe("legacy embedding settings", () => {
	it("reads a block that names both an endpoint and a model", () => {
		expect(
			legacyEmbeddingSettings({
				embedding: { url: "https://example.invalid/v1", model: "m" },
			}),
		).toEqual({ url: "https://example.invalid/v1", model: "m" });
	});

	it("ignores anything else the old parser would have rejected", () => {
		expect(legacyEmbeddingSettings({})).toBeUndefined();
		expect(legacyEmbeddingSettings({ embedding: null })).toBeUndefined();
		expect(legacyEmbeddingSettings({ embedding: "https://example.invalid/v1" })).toBeUndefined();
		expect(legacyEmbeddingSettings({ embedding: { model: "m" } })).toBeUndefined();
		expect(legacyEmbeddingSettings({ embedding: { url: "https://example.invalid/v1" } })).toBeUndefined();
		expect(legacyEmbeddingSettings({ embedding: { url: "", model: "m" } })).toEqual({
			url: "",
			model: "m",
		});
		// An empty model names nothing worth reporting.
		expect(legacyEmbeddingSettings({ embedding: { url: "https://example.invalid/v1", model: "" } })).toBeUndefined();
	});
});

describe("migration label", () => {
	it("labels the old model only for [OI]'s own endpoint", () => {
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
