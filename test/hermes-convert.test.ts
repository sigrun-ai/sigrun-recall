import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	convertChain,
	selectRoots,
	type HermesMessage,
	type HermesSession,
} from "../scripts/hermes-convert.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sessions(): HermesSession[] {
	return [
		{ id: "root", source: "webui", model: "synthetic-model", startedAt: 100, parentSessionId: null, title: "Synthetic title" },
		{ id: "continued", source: "webui", model: "synthetic-model", startedAt: 200, parentSessionId: "root", title: null },
		{ id: "cron", source: "cron", model: null, startedAt: 50, parentSessionId: null, title: "Excluded" },
	];
}

function messages(): HermesMessage[] {
	return [
		{ role: "user", content: "first question", toolCalls: null, toolCallId: null, toolName: null, timestamp: 100 },
		{
			role: "assistant",
			content: "checking",
			toolCalls: JSON.stringify([{ id: "call-1", function: { name: "web_fetch", arguments: '{"url":"https://example.invalid/a"}' } }]),
			toolCallId: null,
			toolName: null,
			timestamp: 101,
		},
		{ role: "tool", content: "result", toolCalls: null, toolCallId: "call-1", toolName: "web_fetch", timestamp: 102 },
	];
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "hermes-convert-"));
	roots.push(root);
	const path = join(root, "state.db");
	const db = new DatabaseSync(path);
	db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, model TEXT, started_at INTEGER, parent_session_id TEXT, title TEXT);
		CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_calls TEXT, tool_call_id TEXT, tool_name TEXT, timestamp INTEGER, active INTEGER, compacted INTEGER);`);
	db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)").run("root", "webui", "synthetic-model", 100, null, null);
	const insert = db.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
	insert.run(1, "root", "user", "first user message", null, null, null, 100, 1, 0);
	insert.run(2, "root", "assistant", "rewound", null, null, null, 101, 0, 0);
	insert.run(3, "root", "assistant", "compacted", null, null, null, 102, 0, 1);
	db.close();
	return path;
}

describe("Hermes converter", () => {
	it("selectRoots joins a compression continuation onto its root and drops cron sessions", () => {
		const selected = selectRoots(sessions());
		expect(selected).toHaveLength(1);
		expect(selected[0]?.chain.map((session) => session.id)).toEqual(["root", "continued"]);
	});

	it("convertChain maps a Hermes tool call to a ToolCall with parsed arguments and a following pi.tool-result with the same toolCallId", () => {
		const converted = convertChain([sessions()[0]!], () => messages());
		const assistant = JSON.parse(converted.lines[1]!).model[0];
		const tool = JSON.parse(converted.lines[2]!).model[0];
		expect(assistant.content[1]).toMatchObject({
			type: "toolCall",
			id: "call-1",
			name: "web_fetch",
			arguments: { url: "https://example.invalid/a" },
		});
		expect(tool).toMatchObject({ role: "toolResult", toolCallId: "call-1", toolName: "web_fetch" });
	});

	it("timestamps are converted from seconds to milliseconds", () => {
		const converted = convertChain([sessions()[0]!], () => messages());
		expect(JSON.parse(converted.lines[0]!).model[0].timestamp).toBe(100_000);
		expect(JSON.parse(converted.lines[1]!).model[0].timestamp).toBe(101_000);
	});

	it("an unparsable tool-call arguments string becomes {} with argumentsError", () => {
		const bad = messages();
		bad[1]!.toolCalls = JSON.stringify([{ id: "bad", function: { name: "web_fetch", arguments: "{" } }]);
		const converted = convertChain([sessions()[0]!], () => bad);
		expect(JSON.parse(converted.lines[1]!).model[0].content[1]).toMatchObject({
			arguments: {},
			argumentsError: expect.any(String),
		});
	});

	it("the name is the session title when present, else the first user message collapsed to ≤ 60 chars", () => {
		expect(convertChain([sessions()[0]!], () => messages()).name).toBe("Synthetic title");
		const unnamed = { ...sessions()[0]!, title: null };
		expect(convertChain([unnamed], () => messages()).name).toBe("first question");
		const long = messages();
		long[0]!.content = "  first   user " + "x".repeat(100);
		expect(convertChain([unnamed], () => long).name.length).toBeLessThanOrEqual(60);
	});

	it("a rewound row (active 0, compacted 0) is dropped and a compacted row (active 0, compacted 1) is kept", async () => {
		const path = await fixture();
		const { readHermes } = await import("../scripts/hermes-convert.js");
		const history = readHermes(path);
		const converted = convertChain(history.roots[0]!.chain, history.messagesOf);
		expect(converted.lines.some((line) => line.includes("compacted"))).toBe(true);
		expect(converted.lines.some((line) => line.includes("rewound"))).toBe(false);
	});

	it("every emitted line passes the import route's own parse rules (object, non-empty kind, model array)", () => {
		const converted = convertChain([sessions()[0]!], () => messages());
		for (const line of converted.lines) {
			const parsed = JSON.parse(line);
			expect(typeof parsed).toBe("object");
			expect(parsed).not.toBeNull();
			expect(typeof parsed.kind).toBe("string");
			expect(parsed.kind).not.toBe("");
			expect(Array.isArray(parsed.model)).toBe(true);
		}
	});
});
