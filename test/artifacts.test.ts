import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ToolExecutionResult, ToolHookCall } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";

import {
	createArtifactStore,
	externalize,
	outline,
} from "../src/artifacts.js";
import { RecallDb } from "../src/db.js";

const roots: string[] = [];
const databases: RecallDb[] = [];

afterEach(async () => {
	for (const db of databases.splice(0)) db.close();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function result(text: string): ToolExecutionResult {
	return { output: [{ type: "text", text }] };
}

function call(parent = false): ToolHookCall {
	return {
		type: "toolCall",
		id: "call-1",
		name: "web_fetch",
		arguments: { url: "https://example.invalid/page" },
		...(parent ? { parent: { taskId: 1, callId: "nested-1" } } : {}),
	} as ToolHookCall;
}

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "recall-artifacts-"));
	roots.push(root);
	const db = RecallDb.open(":memory:");
	databases.push(db);
	const dir = join(root, "artifacts");
	return {
		db,
		dir,
		store: createArtifactStore(db, dir),
		deps: (thresholdBytes = 24_576) => ({
			store: createArtifactStore(db, dir),
			thresholdBytes,
			conversationId: 1,
			owner: "alice",
			now: 1_700_000_000_000,
		}),
	};
}

describe("artifacts", () => {
	it("a 30000-byte text result is replaced by a stub that starts with the first lines, names the handle, and is ≤ 6144 + outline bytes", async () => {
		const { store, deps } = await setup();
		const text = "first line\n" + "x".repeat(30_000);
		const original = result(text);
		const replaced = externalize(original, call(), deps());

		expect(replaced).toBeDefined();
		const output = replaced?.output?.[0];
		expect(output?.type).toBe("text");
		const stub = output?.type === "text" ? output.text : "";
		const handle = store.put(text, { conversationId: 1, owner: "alice", at: 1 }).handle;
		expect(stub.startsWith("first line\n")).toBe(true);
		expect(stub).toContain(handle);
		expect(stub.length).toBeLessThanOrEqual(6144 + 9000);
	});

	it("a shell result with structuredOutput {truncated: true, fullOutputPath} is left alone", async () => {
		const { deps } = await setup();
		const text = "x".repeat(30_000);
		expect(
			externalize(
				{
					...result(text),
					structuredOutput: { truncated: true, fullOutputPath: "/tmp/synthetic-output" },
				},
				call(),
				deps(),
			),
		).toBeUndefined();
		expect(
			externalize(
				{ ...result(text), structuredOutput: { truncated: true } },
				call(),
				deps(),
			),
		).toBeUndefined();
	});

	it("the artifacts directory is created on first write", async () => {
		const { store, dir } = await setup();
		expect(existsSync(dir)).toBe(false);
		const saved = store.put("whole artifact", { conversationId: 1, owner: "alice", at: 1 });
		expect(existsSync(dir)).toBe(true);
		expect(store.read(saved.handle, 0, 100)).toBe("whole artifact");
	});

	it("a 20000-byte result is left alone", async () => {
		const { deps } = await setup();
		expect(externalize(result("x".repeat(20_000)), call(), deps())).toBeUndefined();
	});

	it("a nested call (call.parent set) is never externalized", async () => {
		const { deps } = await setup();
		expect(externalize(result("x".repeat(30_000)), call(true), deps())).toBeUndefined();
	});

	it("the same page externalized twice yields one artifact file and one set of items", async () => {
		const { db, dir, deps } = await setup();
		const text = "# Page\n" + "content\n".repeat(4000);
		externalize(result(text), call(), deps());
		const second = externalize(result(text), call(), deps());
		expect(second).toBeDefined();
		expect(readdirSync(dir)).toHaveLength(1);
		expect(db.item(1)).toMatchObject({ kind: "artifact", offset: 0 });
		expect(db.item(18)).toBeUndefined();
	});

	it("a 5 MB result with a 1 MB base64 run is stored whole, its stub ≤ 9000 bytes, and no indexed item text contains a 200-char base64 run", async () => {
		const { db, deps, dir } = await setup();
		const text = "prefix\n" + "A".repeat(1024 * 1024) + "\nsuffix" + "x".repeat(5 * 1024 * 1024);
		const replaced = externalize(result(text), call(), deps());
		const stub = replaced?.output?.[0]?.type === "text" ? replaced.output[0].text : "";
		expect(Buffer.byteLength(stub)).toBeLessThanOrEqual(9000);
		const [file] = readdirSync(dir);
		expect(readFileSync(join(dir, file!), "utf8")).toBe(text);
		const handle = `a:${file!.slice(0, 16)}`;
		expect(db.matchTrigram('"prefix"')).toEqual([1]);
		for (let id = 1; id <= Math.ceil(text.length / 2000); id += 1) {
			const item = db.item(id);
			expect(item).toMatchObject({ kind: "artifact", artifact: handle });
			const indexed = db.itemText(id);
			expect(indexed).toBeDefined();
			expect(/[A-Za-z0-9+/]{200}/.test(indexed!)).toBe(false);
		}
		expect(db.item(Math.ceil(text.length / 2000) + 1)).toBeUndefined();
	});

	it("a multibyte result's stub head is byte-bounded and outline offsets are byte offsets", async () => {
		const { deps } = await setup();
		const text = `é\n# Préface\n${"界".repeat(6000)}\n## Suite\n${"x".repeat(8000)}`;
		const replaced = externalize(result(text), call(), deps());
		const stub = replaced?.output?.[0]?.type === "text" ? replaced.output[0].text : "";
		const marker = stub.indexOf("[recall:");
		const head = stub.slice(0, marker).replace(/\n\n$/, "");
		expect(Buffer.byteLength(head)).toBeLessThanOrEqual(6144);
		expect(Buffer.from(head, "utf8").toString("utf8")).toBe(head);
		expect(head).toBe(text.slice(0, text.indexOf("界")));
		expect(outline(text)).toEqual([
			{ title: "Préface", offset: 3 },
			{ title: "Suite", offset: 3 + Buffer.byteLength("# Préface\n") + 6000 * 3 + 1 },
		]);
	});

	it('outline of "# A\ntext\n## B\n" returns [{title:"A",offset:0},{title:"B",offset:9}]', () => {
		expect(outline("# A\ntext\n## B\n")).toEqual([
			{ title: "A", offset: 0 },
			{ title: "B", offset: 9 },
		]);
	});
});
