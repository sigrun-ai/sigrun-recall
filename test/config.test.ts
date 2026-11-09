import { describe, expect, it, vi } from "vitest";

import {
	migrationLabel,
	resolveSettings,
	resolveUserSettings,
	type SettingsReader,
} from "../src/config.js";

function settingsReader(values: Record<string, unknown>): SettingsReader {
	return { get: async () => values };
}

describe("settings", () => {
	it("resolveSettings fills defaults: externalizeBytes 24576 and no embedding", async () => {
		expect(await resolveSettings(settingsReader({}))).toEqual({
			externalizeBytes: 24_576,
		});
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
