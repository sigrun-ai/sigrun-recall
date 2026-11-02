import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Context } from "@earendil-works/chord";
import type {
	EntryRecord,
	ToolExecutionApi,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import { afterEach, describe, expect, it } from "vitest";

import { createArtifactStore } from "../src/artifacts.js";
import { RecallDb, type ItemRow } from "../src/db.js";
import { createSearcher } from "../src/search.js";
import { createTools, type ToolsDeps } from "../src/tools.js";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const roots: string[] = [];
const databases: RecallDb[] = [];

afterEach(async () => {
	for (const db of databases.splice(0)) db.close();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
	return {
		pinned: false,
		tagged: [],
		archived: false,
		draft: { text: "", attachments: [] },
		source: "test",
		owner: "alice",
		name: "Clinic notes",
		...overrides,
	};
}

function message(id: number, conversationId: number, role: "user" | "assistant", text: string): EntryRecord {
	return {
		id,
		conversationId,
		kind: "pi.message",
		model: [{ role, content: [{ type: "text", text }], timestamp: NOW }],
	} as unknown as EntryRecord;
}

function item(overrides: Partial<Omit<ItemRow, "id">> = {}): Omit<ItemRow, "id"> {
	return {
		conversationId: 1,
		owner: "alice",
		kind: "turn",
		entryId: 1,
		messageIndex: 0,
		offset: 0,
		length: 6,
		artifact: null,
		job: false,
		cls: "normal",
		at: NOW,
		title: null,
		...overrides,
	};
}

async function setup(options: { cls?: "normal" | "local-only"; provider?: string } = {}) {
	const db = RecallDb.open(":memory:");
	databases.push(db);
	db.insertItem(item({ cls: options.cls ?? "normal" }), "clinic");
	const metas = new Map<number, SessionMeta>([
		[1, meta()],
		[2, meta({ name: "Current conversation" })],
	]);
	const entries = [message(1, 1, "user", "clinic")];
	const root = await mkdtemp(join(tmpdir(), "recall-tools-"));
	roots.push(root);
	const artifactStore = createArtifactStore(db, join(root, "artifacts"));
	const entry = async (conversationId: number, entryId: number) =>
		entries.find((value) => value.conversationId === conversationId && value.id === entryId);
	const searcher = createSearcher({
		db,
		meta: async (id) => metas.get(id)!,
		entry,
		userSettings: async () => ({ autoRecall: true, localProviders: ["acme-local"] }),
		now: () => NOW,
		artifactStore,
	});
	const deps: ToolsDeps = {
		db,
		searcher,
		artifactStore,
		meta: async (id) => metas.get(id)!,
		entries: async (conversationId, query) => ({
			items: entries.filter(
				(value) =>
					value.conversationId === conversationId &&
					(query.minEntryId === undefined || value.id >= query.minEntryId) &&
					(query.maxEntryId === undefined || value.id <= query.maxEntryId),
			),
		}),
		localProviders: async () => ["acme-local"],
	};
	const tools = createTools(deps);
	return { db, metas, entries, artifactStore, tools };
}

async function execute(
	tools: readonly ToolRegistration[],
	name: "recall_search" | "recall_open",
	args: Record<string, unknown>,
	provider = "acme-local",
): Promise<string> {
	const tool = tools.find((candidate) => candidate.name === name)!;
	const api = {
		conversationId: 2,
		agent: async () => ({ model: { provider, modelId: "test-model" } }),
	} as unknown as ToolExecutionApi;
	const result = await tool.execute(args as never, api, {} as Context);
	return (result.output ?? [])
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n");
}

describe("recall tools", () => {
	it("recall_search groups hits by conversation with date, title and handle", async () => {
		const { tools } = await setup();
		const text = await execute(tools, "recall_search", { query: "clinic" });
		expect(text).toBe("[2026-11-02] Clinic notes — clinic (r:1)");
	});

	it('recall_search returns "No matching past material." when empty', async () => {
		const { tools } = await setup();
		expect(await execute(tools, "recall_search", { query: "absent" })).toBe(
			"No matching past material.",
		);
	});

	it("recall_open(\"r:<id>\") shows the surrounding turns", async () => {
		const { tools, entries } = await setup();
		entries.push(message(2, 1, "assistant", "surrounding answer"));
		expect(await execute(tools, "recall_open", { handle: "r:1" })).toBe(
			"user: clinic\nassistant: surrounding answer",
		);
	});

	it('recall_open("a:<hash>", {offset: 6144}) returns the next slice', async () => {
		const { tools, artifactStore } = await setup();
		const text = "x".repeat(6144) + "next slice";
		const saved = artifactStore.put(text, { conversationId: 1, owner: "alice", at: NOW });
		expect(
			await execute(tools, "recall_open", { handle: saved.handle, offset: 6144 }),
		).toBe("next slice");
	});

	it('recall_open on an item whose conversation is no longer shared returns "Not available here."', async () => {
		const { tools, metas } = await setup();
		metas.set(2, meta({ owner: "bob", name: "Current conversation" }));
		metas.set(1, meta({ sharing: { scope: "people", users: ["bob"], level: "read" } }));
		const text = await execute(tools, "recall_open", { handle: "r:1" }, "acme-local");
		expect(text).toBe("Not available here.");
	});

	it("a local-only result taints the conversation so its later turns capture as local-only", async () => {
		const { db, tools } = await setup({ cls: "local-only" });
		expect(await execute(tools, "recall_search", { query: "clinic" })).toContain("r:1");
		expect(db.taintFrom(2)).toBe(1);
	});
});
