import { describe, expect, it } from "vitest";

import { redact } from "../src/redact.js";

describe("redact", () => {
	it('redact replaces "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456" with "Authorization: [redacted:bearer]"', () => {
		expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456")).toBe(
			"Authorization: [redacted:bearer]",
		);
	});

	it("redact turns a 500-char base64 run into [binary]", () => {
		expect(redact("A".repeat(500))).toBe("[binary]");
	});
});
