import { describe, expect, it, vi } from "vitest";

import {
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
