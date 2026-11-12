import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { RecallDb, type DocRow, type ItemRow } from "../src/db.js";
import type { SittingRow, LineRow, MonthLineRow, SittingBlock, PreviousExchange } from "../src/sittings/types.js";

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

  it("a fresh database opens with the docs table", () => {
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
    db.upsertVector(itemId, "acme-local/embed-1", new Float32Array([1, 0]));

    expect(db.removeDoc("acme-local", "alice", "k1")).toBe(true);

    expect(db.doc(result.id)).toBeUndefined();
    expect(db.item(itemId)).toBeUndefined();
    expect(db.searchPorter("riverside", 10)).toEqual([]);
    expect(db.matchTrigram('"ver"')).toEqual([]);
    expect(db.listVectorsPage("acme-local/embed-1", 0, 10)).toEqual([]);
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

describe("model-scoped vectors", () => {
  const OLD_MODEL = "openai/text-embedding-3-small";
  const NEW_MODEL = "acme-local/embed-2";

  function floats(buffer: Buffer): number[] {
    return [...new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))];
  }

  /** Rewrite a fresh database's vectors table into the v3 shape: one row per item, no model. */
  function toV3(path: string, vectors: { itemId: number; vec: Float32Array }[]): void {
    const raw = new DatabaseSync(path);
    try {
      raw.exec("DROP TABLE vectors");
      raw.exec(`
        CREATE TABLE vectors (
          itemId INTEGER PRIMARY KEY,
          dim INTEGER NOT NULL,
          vec BLOB NOT NULL
        );
      `);
      for (const { itemId, vec } of vectors) {
        raw
          .prepare("INSERT INTO vectors (itemId, dim, vec) VALUES (?, ?, ?)")
          .run(itemId, vec.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
      }
      raw.exec("UPDATE schema_version SET version = 3");
    } finally {
      raw.close();
    }
  }

  /** A v3 database with two items and one vector each, ready for the v4 migration. */
  async function seededV3(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "recall-v4-"));
    temporaryDirectories.push(root);
    const path = join(root, "recall.db");
    const seed = RecallDb.open(path);
    seed.insertItem(item(), "electrician");
    seed.insertItem(item({ entryId: 11 }), "plumber");
    seed.close();
    toV3(path, [
      { itemId: 1, vec: new Float32Array([1, 0]) },
      { itemId: 2, vec: new Float32Array([0, 1]) },
    ]);
    return path;
  }

  it("v3 → v4 keeps every vector", async () => {
    const path = await seededV3();

    const db = RecallDb.open(path, OLD_MODEL);
    openDatabases.push(db);

    const page = db.listVectorsPage(OLD_MODEL, 0, 10);
    expect(page.map((row) => row.itemId)).toEqual([1, 2]);
    expect(floats(page[0]!.vec)).toEqual([1, 0]);
    expect(floats(page[1]!.vec)).toEqual([0, 1]);
    // The rebuilt table is keyed by model, not by item alone.
    expect(db.listVectorsPage("", 0, 10)).toEqual([]);
    expect(db.item(1)).toEqual({ id: 1, ...item() });
  });

  it("openai rows are labelled, others are not", async () => {
    const labelledPath = await seededV3();
    const labelled = RecallDb.open(labelledPath, OLD_MODEL);
    openDatabases.push(labelled);
    expect(labelled.listVectorsPage(OLD_MODEL, 0, 10)).toHaveLength(2);

    const unlabelledPath = await seededV3();
    const unlabelled = RecallDb.open(unlabelledPath);
    openDatabases.push(unlabelled);
    // No label: the rows sit under the never-matching model "" and are re-embedded.
    expect(unlabelled.listVectorsPage(OLD_MODEL, 0, 10)).toEqual([]);
    expect(unlabelled.listVectorsPage("", 0, 10)).toHaveLength(2);
  });

  it("unembedded means lacking a row for this model", () => {
    const db = openMemory();
    db.insertItem(item(), "electrician");
    db.insertItem(item({ entryId: 11 }), "plumber");
    db.upsertVector(1, OLD_MODEL, new Float32Array([1, 0]));

    expect(db.listUnembeddedItems(OLD_MODEL, 10, false).map((row) => row.id)).toEqual([2]);
    expect(db.listUnembeddedItems(NEW_MODEL, 10, false).map((row) => row.id)).toEqual([1, 2]);
  });

  it("old model rows survive until coverage, then are deleted", () => {
    const db = openMemory();
    db.insertItem(item(), "electrician");
    db.upsertVector(1, OLD_MODEL, new Float32Array([1, 0]));

    expect(db.modelCoverage(NEW_MODEL, false)).toEqual({ complete: false });
    expect(db.listVectorsPage(OLD_MODEL, 0, 10)).toHaveLength(1);

    db.upsertVector(1, NEW_MODEL, new Float32Array([0, 1]));
    expect(db.modelCoverage(NEW_MODEL, false)).toEqual({ complete: true });

    db.deleteVectorsExcept(NEW_MODEL);
    expect(db.listVectorsPage(OLD_MODEL, 0, 10)).toEqual([]);
    expect(db.listVectorsPage(NEW_MODEL, 0, 10).map((row) => row.itemId)).toEqual([1]);
  });

  it("a table-shaped database with no version row still gets the v4 vectors shape", async () => {
    // SCHEMA's `CREATE TABLE IF NOT EXISTS` never reshapes an existing
    // vectors table, so a database carrying tables but no version row must
    // still be rebuilt — otherwise it keeps the pre-model shape forever.
    const root = await mkdtemp(join(tmpdir(), "recall-v4-noversion-"));
    temporaryDirectories.push(root);
    const path = join(root, "recall.db");
    const seed = RecallDb.open(path);
    seed.insertItem(item(), "electrician");
    seed.close();
    toV3(path, [{ itemId: 1, vec: new Float32Array([1, 0]) }]);
    const raw = new DatabaseSync(path);
    try {
      raw.exec("DELETE FROM schema_version");
    } finally {
      raw.close();
    }

    const db = RecallDb.open(path, OLD_MODEL);
    openDatabases.push(db);

    expect(db.listVectorsPage(OLD_MODEL, 0, 10).map((row) => row.itemId)).toEqual([1]);
  });

  it("dangling and local-only-ineligible items don't block coverage", () => {
    const db = openMemory();
    db.insertItem(item(), "electrician");
    db.upsertVector(1, NEW_MODEL, new Float32Array([1, 0]));
    // Dangling: a turn with no entry to read its text from.
    db.insertItem(item({ entryId: null, messageIndex: 0 }), "orphan");
    // Dangling: a doc item whose doc row is gone.
    db.insertItem(item({ conversationId: null, kind: "doc", entryId: null, messageIndex: null, doc: null }), "orphan");
    // Eligible for a local model only.
    db.insertItem(item({ entryId: 11, cls: "local-only" }), "private");

    expect(db.modelCoverage(NEW_MODEL, false)).toEqual({ complete: true });
    expect(db.modelCoverage(NEW_MODEL, true)).toEqual({ complete: false });
  });
});

describe("v5 schema — sittings", () => {
  /** A v4 database seeded by SCHEMA then downgraded to version 4. */
  async function seededV4(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "recall-v5-"));
    temporaryDirectories.push(root);
    const path = join(root, "recall.db");
    const seed = RecallDb.open(path);
    seed.insertItem(item(), "electrician");
    seed.close();
    const raw = new DatabaseSync(path);
    try {
      raw.exec("UPDATE schema_version SET version = 4");
    } finally {
      raw.close();
    }
    return path;
  }

  function sittingRow(overrides: Partial<SittingRow> = {}): SittingRow {
    return {
      conversationId: 1,
      startEntryId: 10,
      startAt: 1_700_000_000_000,
      boundary: false,
      boundaryText: "",
      previous: null,
      block: null,
      title: null,
      titleState: "none",
      ...overrides,
    };
  }

  function lineRow(overrides: Partial<LineRow> = {}): LineRow {
    return {
      conversationId: 1,
      startEntryId: 10,
      text: "hello",
      cls: "normal",
      coversThrough: 15,
      sealed: false,
      ...overrides,
    };
  }

  function monthLineRow(overrides: Partial<MonthLineRow> = {}): MonthLineRow {
    return {
      conversationId: 1,
      month: "2024-01",
      text: "january line",
      cls: "normal",
      ...overrides,
    };
  }

  const previousExchange: PreviousExchange = {
    user: { role: "user", content: "hi", timestamp: 1_700_000_000_000 },
    assistant: {
      role: "assistant",
      content: [],
      timestamp: 1_700_000_000_001,
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
    },
  };

  const sittingBlock: SittingBlock = {
    header: "## Sitting",
    toc: [{ startAt: 1_700_000_000_000, title: "t", text: "toc", cls: "normal", month: "2024-01" }],
    recall: { text: "recall text", cls: "normal", sources: [1, 2] },
  };

  it("a v4 database opens as v5 with the four new tables", async () => {
    const path = await seededV4();

    const db = RecallDb.open(path);
    openDatabases.push(db);

    // The new tables accept writes.
    expect(db.decision(1, 10)).toBeUndefined();
    db.putDecision(1, 10, false);
    expect(db.decision(1, 10)).toBe(false);

    db.putSitting(sittingRow());
    expect(db.sittings([1])).toHaveLength(1);

    db.putLineDraft(lineRow());
    expect(db.lines([1])).toHaveLength(1);

    db.putMonthLine(monthLineRow());
    expect(db.monthLines([1])).toHaveLength(1);

    // The old rows survive.
    expect(db.item(1)).toEqual({ id: 1, ...item() });
  });

  it("putSitting twice keeps the first row", () => {
    const db = openMemory();
    db.putSitting(sittingRow({ title: "first" }));
    db.putSitting(sittingRow({ title: "second" }));

    const rows = db.sittings([1]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("first");
  });

  it("sittings returns rows ordered by startEntryId", () => {
    const db = openMemory();
    db.putSitting(sittingRow({ startEntryId: 20, title: "second" }));
    db.putSitting(sittingRow({ startEntryId: 10, title: "first" }));

    const rows = db.sittings([1]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.startEntryId).toBe(10);
    expect(rows[1]!.startEntryId).toBe(20);
  });

  it("createBoundary twice returns true then false and the second call changes nothing", () => {
    const db = openMemory();

    const first = db.createBoundary(
      sittingRow({ boundary: true, title: "boundary-title" }),
      { startEntryId: 5, line: { text: "sealed text", cls: "normal", coversThrough: 9 } },
    );
    expect(first).toBe(true);

    // Second call with DIFFERENT content must return false and change nothing.
    const second = db.createBoundary(
      sittingRow({ boundary: true, title: "overwritten" }),
      { startEntryId: 5, line: { text: "different", cls: "local-only", coversThrough: 99 } },
    );
    expect(second).toBe(false);

    const rows = db.sittings([1]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("boundary-title");

    // The sealed line stays as the first call wrote it.
    const lines = db.lines([1]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("sealed text");
    expect(lines[0]!.sealed).toBe(true);

    // The decision stays as the first call wrote it.
    expect(db.decision(1, 10)).toBe(true);
  });

  it("createBoundary with undefined sealPrevious does not seal a line", () => {
    const db = openMemory();

    const result = db.createBoundary(sittingRow({ boundary: true }), undefined);
    expect(result).toBe(true);

    expect(db.sittings([1])).toHaveLength(1);
    expect(db.lines([1])).toHaveLength(0);
  });

  it("putLineDraft after sealLine leaves the sealed text", () => {
    const db = openMemory();
    db.sealLine(1, 10, { text: "sealed", cls: "normal", coversThrough: 15 });
    db.putLineDraft({ ...lineRow({ text: "draft" }) });

    const lines = db.lines([1]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("sealed");
    expect(lines[0]!.sealed).toBe(true);
  });

  it("sealLine is a no-op when the row is already sealed", () => {
    const db = openMemory();
    db.sealLine(1, 10, { text: "sealed", cls: "normal", coversThrough: 15 });
    db.sealLine(1, 10, { text: "different", cls: "local-only", coversThrough: 99 });

    const lines = db.lines([1]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("sealed");
    expect(lines[0]!.cls).toBe("normal");
  });

  it("sealLine upserts a draft row to sealed", () => {
    const db = openMemory();
    db.putLineDraft(lineRow({ text: "draft" }));
    expect(db.lines([1])[0]!.sealed).toBe(false);

    db.sealLine(1, 10, { text: "sealed", cls: "normal", coversThrough: 20 });

    const lines = db.lines([1]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe("sealed");
    expect(lines[0]!.sealed).toBe(true);
    expect(lines[0]!.coversThrough).toBe(20);
  });

  it("putMonthLine twice keeps the first", () => {
    const db = openMemory();
    db.putMonthLine(monthLineRow({ text: "first" }));
    db.putMonthLine(monthLineRow({ text: "second" }));

    const rows = db.monthLines([1]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("first");
  });

  it("setSittingTitle updates the title and state", () => {
    const db = openMemory();
    db.putSitting(sittingRow({ titleState: "pending" }));

    db.setSittingTitle(1, 10, "my title", "done");

    const rows = db.sittings([1]);
    expect(rows[0]!.title).toBe("my title");
    expect(rows[0]!.titleState).toBe("done");
  });

  it("JSON columns round-trip previous and block", () => {
    const db = openMemory();
    db.putSitting(sittingRow({ previous: previousExchange, block: sittingBlock }));

    const rows = db.sittings([1]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.previous).toEqual(previousExchange);
    expect(rows[0]!.block).toEqual(sittingBlock);
  });

  it("decision round-trips the full boolean", () => {
    const db = openMemory();
    expect(db.decision(1, 10)).toBeUndefined();

    db.putDecision(1, 10, true);
    expect(db.decision(1, 10)).toBe(true);

    db.putDecision(1, 10, false);
    expect(db.decision(1, 10)).toBe(false);
  });
});
