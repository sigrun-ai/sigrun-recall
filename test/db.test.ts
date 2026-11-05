import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { RecallDb, type DocRow, type ItemRow } from "../src/db.js";

const openDatabases: RecallDb[] = [];
const temporaryDirectories: string[] = [];

function openMemory(): RecallDb {
  const db = RecallDb.open(":memory:");
  openDatabases.push(db);
  return db;
}

function item(
  overrides: Partial<Omit<ItemRow, "id">> = {},
): Omit<ItemRow, "id"> {
  return {
    conversationId: 1,
    owner: "alice",
    kind: "turn",
    entryId: 10,
    messageIndex: 0,
    blockIndex: 0,
    offset: 0,
    length: 11,
    artifact: null,
    doc: null,
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
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
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

describe("user-owned documents", () => {
  const NOW = 1_700_000_000_000;

  function doc(
    overrides: Partial<Omit<DocRow, "id" | "updatedAt">> = {},
  ): Omit<DocRow, "id" | "updatedAt"> {
    return {
      provider: "acme-local",
      docId: "k1",
      owner: "alice",
      kind: "note",
      title: "clinic checklist",
      url: null,
      at: NOW,
      cls: "normal",
      text: "the riverside clinic keeps the ledger",
      sources: [],
      ...overrides,
    };
  }

  async function openV2(path: string): Promise<void> {
    const raw = new DatabaseSync(path);
    try {
      raw.exec(`
        CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          conversationId INTEGER NOT NULL,
          owner TEXT,
          kind TEXT NOT NULL CHECK (kind IN ('turn', 'tool', 'artifact')),
          entryId INTEGER,
          messageIndex INTEGER,
          blockIndex INTEGER NOT NULL DEFAULT 0,
          offset INTEGER NOT NULL,
          length INTEGER NOT NULL,
          artifact TEXT,
          job INTEGER NOT NULL CHECK (job IN (0, 1)),
          cls TEXT NOT NULL CHECK (cls IN ('normal', 'local-only')),
          at INTEGER NOT NULL,
          title TEXT
        );
        CREATE UNIQUE INDEX items_message_key
          ON items (conversationId, kind, entryId, messageIndex, blockIndex, offset)
          WHERE kind IN ('turn', 'tool');
        CREATE UNIQUE INDEX items_artifact_key
          ON items (artifact, offset)
          WHERE kind = 'artifact';
        CREATE VIRTUAL TABLE fts_porter
          USING fts5(text, tokenize='porter unicode61', content='');
        CREATE VIRTUAL TABLE fts_trigram
          USING fts5(text, tokenize='trigram', content='');
        CREATE TABLE schema_version (version INTEGER NOT NULL);
      `);
      raw
        .prepare(
          `INSERT INTO items (
            conversationId, owner, kind, entryId, messageIndex, blockIndex, offset,
            length, artifact, job, cls, at, title
          ) VALUES (1, 'alice', 'turn', 10, 0, 0, 0, 11, NULL, 0, 'normal', ${NOW}, NULL)`,
        )
        .run();
      raw.prepare("INSERT INTO fts_porter(rowid, text) VALUES (1, 'electrician')").run();
      raw.prepare("INSERT INTO fts_trigram(rowid, text) VALUES (1, 'electrician')").run();
      raw.prepare("INSERT INTO schema_version (version) VALUES (2)").run();
    } finally {
      raw.close();
    }
  }

  it("a v2 database migrates to v3 keeping item ids and FTS matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "recall-v3-"));
    temporaryDirectories.push(root);
    const path = join(root, "recall.db");
    await openV2(path);

    const db = RecallDb.open(path);
    openDatabases.push(db);

    expect(db.item(1)).toEqual({ id: 1, ...item() });
    expect(db.searchPorter("electrician", 10).map((hit) => hit.id)).toEqual([1]);
    expect(db.matchTrigram('"lectric"')).toEqual([1]);
  });

  it("a v1 database migrates to v3 keeping item ids and FTS matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "recall-v1-"));
    temporaryDirectories.push(root);
    const path = join(root, "recall.db");
    const raw = new DatabaseSync(path);
    try {
      // The v1 shape: items without blockIndex/doc, injections without sources.
      raw.exec(`
        CREATE TABLE items (
          id INTEGER PRIMARY KEY,
          conversationId INTEGER NOT NULL,
          owner TEXT,
          kind TEXT NOT NULL CHECK (kind IN ('turn', 'tool', 'artifact')),
          entryId INTEGER,
          messageIndex INTEGER,
          offset INTEGER NOT NULL,
          length INTEGER NOT NULL,
          artifact TEXT,
          job INTEGER NOT NULL CHECK (job IN (0, 1)),
          cls TEXT NOT NULL CHECK (cls IN ('normal', 'local-only')),
          at INTEGER NOT NULL,
          title TEXT
        );
        CREATE UNIQUE INDEX items_message_key
          ON items (conversationId, kind, entryId, messageIndex, offset)
          WHERE kind IN ('turn', 'tool');
        CREATE UNIQUE INDEX items_artifact_key
          ON items (artifact, offset)
          WHERE kind = 'artifact';
        CREATE VIRTUAL TABLE fts_porter
          USING fts5(text, tokenize='porter unicode61', content='');
        CREATE VIRTUAL TABLE fts_trigram
          USING fts5(text, tokenize='trigram', content='');
        CREATE TABLE injections (
          conversationId INTEGER NOT NULL,
          messageKey TEXT NOT NULL,
          block TEXT NOT NULL,
          cls TEXT NOT NULL CHECK (cls IN ('normal', 'local-only')),
          PRIMARY KEY (conversationId, messageKey)
        );
        CREATE TABLE schema_version (version INTEGER NOT NULL);
      `);
      raw
        .prepare(
          `INSERT INTO items (
            conversationId, owner, kind, entryId, messageIndex, offset,
            length, artifact, job, cls, at, title
          ) VALUES (1, 'alice', 'turn', 10, 0, 0, 11, NULL, 0, 'normal', ?, NULL)`,
        )
        .run(NOW);
      raw.prepare("INSERT INTO fts_porter(rowid, text) VALUES (1, 'electrician')").run();
      raw.prepare("INSERT INTO fts_trigram(rowid, text) VALUES (1, 'electrician')").run();
      raw.prepare("INSERT INTO schema_version (version) VALUES (1)").run();
    } finally {
      raw.close();
    }

    const db = RecallDb.open(path);
    openDatabases.push(db);

    expect(db.item(1)).toEqual({ id: 1, ...item() });
    expect(db.searchPorter("electrician", 10).map((hit) => hit.id)).toEqual([1]);
    expect(db.matchTrigram('"lectric"')).toEqual([1]);
    expect(db.doc(1)).toBeUndefined();
    expect(db.insertItem(item({ entryId: 11 }), "plumber")).toBe(2);
  });

  it("a fresh database opens at v3 with the docs table", () => {
    const db = openMemory();

    expect(db.doc(1)).toBeUndefined();
    expect(db.insertItem(item(), "electrician")).toBe(1);
  });

  it("upsertDoc inserts passages that porter and trigram MATCH find", () => {
    const db = openMemory();

    const result = db.upsertDoc(doc(), NOW);

    expect(result.changed).toBe(true);
    const stored = db.doc(result.id);
    expect(stored).toMatchObject({
      provider: "acme-local",
      docId: "k1",
      owner: "alice",
      kind: "note",
      title: "clinic checklist",
      url: null,
      at: NOW,
      cls: "normal",
      text: "the riverside clinic keeps the ledger",
      sources: [],
      updatedAt: NOW,
    });
    const porterHits = db.searchPorter("riverside", 10);
    expect(porterHits).toHaveLength(1);
    expect(db.matchTrigram('"ver"')).toEqual([porterHits[0]!.id]);
    expect(db.item(porterHits[0]!.id)).toMatchObject({
      conversationId: null,
      owner: "alice",
      kind: "doc",
      doc: result.id,
      job: false,
      cls: "normal",
      at: NOW,
      title: "clinic checklist",
    });
    const storedItem = db.item(porterHits[0]!.id)!;
    expect(db.docText(result.id, storedItem.offset, storedItem.length)).toBe(
      "the riverside clinic keeps the ledger",
    );
  });

  it("re-upserting identical content reports changed false and keeps item ids", () => {
    const db = openMemory();
    db.upsertDoc(doc(), NOW);
    const before = db.searchPorter("riverside", 10).map((hit) => hit.id);

    const again = db.upsertDoc(doc(), NOW + 1000);

    expect(again.changed).toBe(false);
    expect(db.searchPorter("riverside", 10).map((hit) => hit.id)).toEqual(before);
    expect(db.doc(again.id)?.updatedAt).toBe(NOW);
  });

  it("upserting new text drops the old passages from both FTS tables", () => {
    const db = openMemory();
    const first = db.upsertDoc(doc(), NOW);

    const second = db.upsertDoc(doc({ text: "the harbourside bakery sells bread" }), NOW + 1);

    expect(second.changed).toBe(true);
    expect(second.id).toBe(first.id);
    expect(db.searchPorter("riverside", 10)).toEqual([]);
    expect(db.matchTrigram('"ver"')).toEqual([]);
    expect(db.searchPorter("harbourside", 10)).toHaveLength(1);
    expect(db.matchTrigram('"arb"')).toHaveLength(1);
    expect(db.doc(first.id)).toMatchObject({
      text: "the harbourside bakery sells bread",
      updatedAt: NOW + 1,
    });
  });

  it("removeDoc deletes the doc, its items, FTS rows and vectors", () => {
    const db = openMemory();
    const result = db.upsertDoc(doc(), NOW);
    const itemId = db.searchPorter("riverside", 10)[0]!.id;
    db.upsertVector(itemId, new Float32Array([1, 0]));

    expect(db.removeDoc("acme-local", "alice", "k1")).toBe(true);

    expect(db.doc(result.id)).toBeUndefined();
    expect(db.item(itemId)).toBeUndefined();
    expect(db.searchPorter("riverside", 10)).toEqual([]);
    expect(db.matchTrigram('"ver"')).toEqual([]);
    expect(db.listVectorsPage(0, 10)).toEqual([]);
    expect(db.removeDoc("acme-local", "alice", "k1")).toBe(false);
  });

  it("docs are keyed per owner: alice's and bob's \"k1\" are two docs", () => {
    const db = openMemory();

    const alice = db.upsertDoc(doc({ text: "alice keeps her ledger" }), NOW);
    const bob = db.upsertDoc(doc({ owner: "bob", text: "bob keeps his ledger" }), NOW);

    expect(bob.id).not.toBe(alice.id);
    expect(db.docByKey("acme-local", "alice", "k1")).toMatchObject({
      id: alice.id,
      owner: "alice",
      text: "alice keeps her ledger",
    });
    expect(db.docByKey("acme-local", "bob", "k1")).toMatchObject({
      id: bob.id,
      owner: "bob",
      text: "bob keeps his ledger",
    });
  });
});
