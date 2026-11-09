import type { EntryRecord } from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import { describe, expect, it, vi } from "vitest";

import { captureConversation } from "../src/capture.js";
import { RecallDb } from "../src/db.js";
import { createSearcher, type SearchContext } from "../src/search.js";
import type { Embedder } from "../src/embed.js";
import {
  createSqliteVectorIndex,
  createVectorArm,
  embedPending,
} from "../src/vectors.js";

const MODEL = "acme-local/embed-1";

function meta(): SessionMeta {
  return {
    pinned: false,
    tagged: [],
    archived: false,
    draft: { text: "", attachments: [] },
    source: "test",
    owner: "alice",
  };
}

function entry(text: string): EntryRecord {
  return {
    id: 1,
    conversationId: 1,
    kind: "pi.message",
    model: [{ role: "user", content: text, timestamp: 1_700_000_000_000 }],
  } as unknown as EntryRecord;
}

function context(): SearchContext {
  return {
    current: { conversationId: 1, owner: "alice" },
    model: { provider: "acme-local" },
    includeJobs: false,
  };
}

describe("vectors", () => {
  it("embedPending does not starve behind unembeddable items", async () => {
    const db = RecallDb.open(":memory:");
    const row = (entryId: number, cls: "normal" | "local-only") => ({
      conversationId: 1,
      owner: "alice",
      kind: "turn" as const,
      entryId,
      messageIndex: 0,
      blockIndex: 0,
      offset: 0,
      length: 4,
      artifact: null,
      doc: null,
      job: false,
      cls,
      at: 1_700_000_000_000,
      title: null,
    });
    for (let id = 1; id <= 501; id += 1)
      db.insertItem(row(id, "local-only"), "local");
    db.insertItem(row(502, "normal"), "text");
    const embed = vi.fn(async (_texts: readonly string[]) => [
      new Float32Array([1]),
    ]);
    await embedPending(
      db,
      { local: false, embed },
      createSqliteVectorIndex(db, MODEL),
      MODEL,
      async () => entry("text"),
      500,
    );
    expect(embed).toHaveBeenCalledWith(["text"]);
    db.close();
  });
  it("a local-only item is not embedded by a non-local embedder", async () => {
    const db = RecallDb.open(":memory:");
    db.setTaint(1, 1);
    const embed = vi.fn(async (_texts: readonly string[]) => [
      new Float32Array([1]),
    ]);
    const embedder: Embedder = { local: false, embed };
    await captureConversation(
      {
        db,
        meta: async () => meta(),
        now: () => 1_700_000_000_000,
        embedder,
        index: createSqliteVectorIndex(db, MODEL),
      },
      1,
      async () => ({ items: [entry("private semantic text")] }),
    );
    await vi.waitFor(() => expect(db.cursor(1)).toBe(1));
    expect(embed).not.toHaveBeenCalled();
    db.close();
  });

  it("capture-time embedding sends redacted text to the embedder", async () => {
    const db = RecallDb.open(":memory:");
    const embed = vi.fn(async (_texts: readonly string[]) => [
      new Float32Array([1]),
    ]);
    const embedder: Embedder = { local: false, embed };
    await captureConversation(
      {
        db,
        meta: async () => meta(),
        now: () => 1_700_000_000_000,
        embedder,
        index: createSqliteVectorIndex(db, MODEL),
      },
      1,
      async () => ({
        items: [
          entry("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"),
        ],
      }),
    );
    await vi.waitFor(() => expect(embed).toHaveBeenCalledOnce());
    const texts = embed.mock.calls[0]?.[0] ?? [];
    expect(texts).toEqual(["Authorization: [redacted:bearer]"]);
    expect(texts[0]).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    db.close();
  });

  it('with a vector arm, a hit with no lexical overlap ("dog surgery" vs "canine knee operation") is found', async () => {
    const db = RecallDb.open(":memory:");
    const record = entry("canine knee operation");
    db.insertItem(
      {
        conversationId: 1,
        owner: "alice",
        kind: "turn",
        entryId: 1,
        messageIndex: 0,
        blockIndex: 0,
        offset: 0,
        length: 21,
        artifact: null,
        doc: null,
        job: false,
        cls: "normal",
        at: 1_700_000_000_000,
        title: null,
      },
      "canine knee operation",
    );
    const index = createSqliteVectorIndex(db, MODEL);
    index.upsert(1, new Float32Array([1, 0]));
    const embedder: Embedder = {
      local: false,
      embed: async () => [new Float32Array([1, 0])],
    };
    const searcher = createSearcher({
      db,
      meta: async () => meta(),
      entry: async () => record,
      userSettings: async () => ({ autoRecall: true, localProviders: [] }),
      vectors: createVectorArm(embedder, index, 800),
      now: () => 1_700_000_000_000,
    });
    const hits = await searcher.search("dog surgery", context(), 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.item.id).toBe(1);
    db.close();
  });

  it("a pending local-only doc is not embedded by a non-local endpoint", async () => {
    const db = RecallDb.open(":memory:");
    db.upsertDoc(
      {
        provider: "acme-local",
        docId: "d1",
        owner: "alice",
        kind: "record",
        title: "Northside Vet research",
        url: null,
        at: 1_700_000_000_000,
        cls: "local-only",
        text: "the harbourside bakery sells bread",
        sources: [],
      },
      1_700_000_000_000,
    );
    const embed = vi.fn(async (_texts: readonly string[]) => [
      new Float32Array([1]),
    ]);
    await embedPending(
      db,
      { local: false, embed },
      createSqliteVectorIndex(db, MODEL),
      MODEL,
      async () => undefined,
    );
    expect(embed).not.toHaveBeenCalled();
    db.close();
  });

  it("a pending normal doc embeds through the sweep with its doc text", async () => {
    const db = RecallDb.open(":memory:");
    db.upsertDoc(
      {
        provider: "acme-local",
        docId: "d1",
        owner: "alice",
        kind: "record",
        title: "Northside Vet research",
        url: null,
        at: 1_700_000_000_000,
        cls: "normal",
        text: "the harbourside bakery sells bread",
        sources: [],
      },
      1_700_000_000_000,
    );
    const embed = vi.fn(async (_texts: readonly string[]) => [
      new Float32Array([1]),
    ]);
    const index = createSqliteVectorIndex(db, MODEL);
    await embedPending(
      db,
      { local: false, embed },
      index,
      MODEL,
      async () => undefined,
    );
    expect(embed).toHaveBeenCalledWith(["the harbourside bakery sells bread"]);
    expect(db.listUnembeddedItems(MODEL, 10, false)).toHaveLength(0);
    db.close();
  });
});

describe("model-scoped vector index", () => {
  it("query scans only the given model", () => {
    const db = RecallDb.open(":memory:");
    try {
      db.insertItem(
        {
          conversationId: 1,
          owner: "alice",
          kind: "turn",
          entryId: 1,
          messageIndex: 0,
          blockIndex: 0,
          offset: 0,
          length: 4,
          artifact: null,
          doc: null,
          job: false,
          cls: "normal",
          at: 1_700_000_000_000,
          title: null,
        },
        "text",
      );
      const older = createSqliteVectorIndex(db, "openai/text-embedding-3-small");
      const newer = createSqliteVectorIndex(db, "acme-local/embed-2");
      older.upsert(1, new Float32Array([1, 0]));
      newer.upsert(1, new Float32Array([0, 1]));

      expect(older.query(new Float32Array([1, 0]), 10)).toEqual([{ itemId: 1, score: 1 }]);
      expect(newer.query(new Float32Array([1, 0]), 10)).toEqual([{ itemId: 1, score: 0 }]);
    } finally {
      db.close();
    }
  });
});
