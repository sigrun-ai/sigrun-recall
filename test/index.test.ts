import { describe, expect, it } from "vitest";

import createRecall from "../src/index.js";

describe("createRecall", () => {
	it("factory.length === 1", () => {
		expect(createRecall.length).toBe(1);
	});
});
