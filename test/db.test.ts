import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RecallDb, type ItemRow } from "../src/db.js";

const openDatabases: RecallDb[] = [];
const temporaryDirectories: string[] = [];

function openMemory(): RecallDb {
	const db = RecallDb.open(":memory:");
	openDatabases.push(db);
	return db;
}

function item(overrides: Partial<Omit<ItemRow, "id">> = {}): Omit<ItemRow, "id"> {
	return {
		conversationId: 1,
		owner: "alice",
		kind: "turn",
		entryId: 10,
		messageIndex: 0,
		offset: 0,
		length: 11,
		artifact: null,
		job: false,
		cls: "normal",
		at: 1_700_000_000_000,
		title: null,
		...overrides,
	};
}

afterEach(async () => {
	for (const db of openDatabases.splice(0)) db.close();
	await Promise.all(
		temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("RecallDb", () => {
	it('RecallDb.open(":memory:") creates the schema and is idempotent when migrated twice', async () => {
		const memory = openMemory();
		expect(memory.insertItem(item(), "electrician")).toBe(1);

		const root = await mkdtemp(join(tmpdir(), "recall-migration-"));
		temporaryDirectories.push(root);
		const path = join(root, "recall.db");
		const first = RecallDb.open(path);
		expect(first.insertItem(item(), "electrician")).toBe(1);
		first.close();

		const second = RecallDb.open(path);
		openDatabases.push(second);
		expect(second.item(1)).toEqual({ id: 1, ...item() });
		expect(second.insertItem(item(), "electrician")).toBeUndefined();
	});

	it('RecallDb.open("<tmp>/nested/dir/recall.db") creates the missing parent directories', async () => {
		const root = await mkdtemp(join(tmpdir(), "recall-db-"));
		temporaryDirectories.push(root);
		const path = join(root, "nested", "dir", "recall.db");
		const db = RecallDb.open(path);
		openDatabases.push(db);

		expect(existsSync(path)).toBe(true);
	});

	it("insertItem returns undefined for a duplicate key and leaves one row", () => {
		const db = openMemory();
		const id = db.insertItem(item(), "electrician");

		expect(id).toBe(1);
		expect(db.insertItem(item(), "electrician")).toBeUndefined();
		expect(db.item(id!)).toEqual({ id, ...item() });
	});

	it('fts_trigram supports substring MATCH: inserting "electrician" makes MATCH \'"lectric"\' return the row', () => {
		const db = openMemory();
		const id = db.insertItem(item(), "electrician");

		expect(db.matchTrigram('"lectric"')).toEqual([id]);
	});
});
