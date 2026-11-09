import type { EntryRecord } from "@earendil-works/pi-durable";
import type { EmbeddingResult } from "@sigrun/shared/embeddings";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import { describe, expect, it, vi } from "vitest";

import { captureConversation } from "../src/capture.js";
import { RecallDb } from "../src/db.js";
import { createSearcher, type SearchContext } from "../src/search.js";
import {
  createSqliteVectorIndex,
  createVectorArm,
  embedPending,
  type EmbeddingHost,
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

/** A fake `host.embeddings` returning a fixed vector per input. */
function fakeEmbeddings(
  embed: (texts: readonly string[]) => EmbeddingResult,
): EmbeddingHost & { embed: ReturnType<typeof vi.fn> } {
  return {
    embed: vi.fn(async (texts: readonly string[]) => embed(texts)),
    list: async () => [],
  } as never;
}

const oneVector = (texts: readonly string[]): EmbeddingResult => ({
  ok: true,
  model: MODEL,
  dimensions: 1,
  vectors: texts.map(() => new Float32Array([1])),
});

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
    const embeddings = fakeEmbeddings(oneVector);
    await embedPending(
      db,
      embeddings,
      MODEL,
      false,
      async () => entry("text"),
      500,
    );
    expect(embeddings.embed).toHaveBeenCalledWith(["text"], {
      confidentiality: "normal",
      model: MODEL,
    });
    db.close();
  });
  it("a local-only item is not embedded by a non-local model", async () => {
    const db = RecallDb.open(":memory:");
    db.setTaint(1, 1);
    // Core's gate (not the caller) decides locality: this model is not
    // trusted for local material, so the local-only batch comes back
    // `not_local` and those items stay lexical.
    const embeddings = fakeEmbeddings(() => ({
      ok: false,
      code: "not_local",
      message: "the model is not local",
    }));
    await captureConversation(
      {
        db,
        meta: async () => meta(),
        now: () => 1_700_000_000_000,
        embeddings,
      },
      1,
      async () => ({ items: [entry("private semantic text")] }),
    );
    await vi.waitFor(() => expect(db.cursor(1)).toBe(1));
    // The page's TWO batches: the normal one is empty for a fully tainted
    // page, so exactly one call carries the local-only items.
    expect(embeddings.embed).toHaveBeenCalledTimes(1);
    expect(embeddings.embed.mock.calls[0]?.[1]).toEqual({ confidentiality: "local-only" });
    expect(db.listVectorsPage(MODEL, 0, 10)).toEqual([]);
    expect(db.item(1)?.cls).toBe("local-only");
    db.close();
  });

  it("capture-time embedding sends redacted text to the embedder", async () => {
    const db = RecallDb.open(":memory:");
    const embeddings = fakeEmbeddings(oneVector);
    await captureConversation(
      {
        db,
        meta: async () => meta(),
        now: () => 1_700_000_000_000,
        embeddings,
      },
      1,
      async () => ({
        items: [
          entry("Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"),
        ],
      }),
    );
    await vi.waitFor(() => expect(embeddings.embed).toHaveBeenCalledOnce());
    const texts = (embeddings.embed.mock.calls[0]?.[0] ?? []) as readonly string[];
    expect(texts).toEqual(["Authorization: [redacted:bearer]"]);
    expect(texts[0]).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    db.close();
  });

  it("capture stores each vector under the model the provider RETURNED", async () => {
    const db = RecallDb.open(":memory:");
    // The provider resolved a different model than any recall-side guess:
    // the vector belongs to THAT model's space.
    const embeddings: EmbeddingHost = {
      embed: async (texts) => ({
        ok: true,
        model: "acme-local/resolved-9",
        dimensions: 1,
        vectors: texts.map(() => new Float32Array([1])),
      }),
      list: async () => [],
    };
    await captureConversation(
      {
        db,
        meta: async () => meta(),
        now: () => 1_700_000_000_000,
        embeddings,
      },
      1,
      async () => ({ items: [entry("a passage")] }),
    );
    await vi.waitFor(() => expect(db.cursor(1)).toBe(1));
    await vi.waitFor(() =>
      expect(db.listVectorsPage("acme-local/resolved-9", 0, 10)).toHaveLength(1),
    );
    expect(db.listVectorsPage(MODEL, 0, 10)).toEqual([]);
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
    const embeddings: EmbeddingHost = {
      embed: async () => ({
        ok: true,
        model: MODEL,
        dimensions: 2,
        vectors: [new Float32Array([1, 0])],
      }),
      list: async () => [],
    };
    const searcher = createSearcher({
      db,
      meta: async () => meta(),
      entry: async () => record,
      userSettings: async () => ({ autoRecall: true, localProviders: [] }),
      vectors: createVectorArm(embeddings, index, MODEL, 800),
      now: () => 1_700_000_000_000,
    });
    const hits = await searcher.search("dog surgery", context(), 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.item.id).toBe(1);
    db.close();
  });

  it("a pending local-only doc is not embedded by a non-local model", async () => {
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
    const embeddings = fakeEmbeddings(oneVector);
    await embedPending(
      db,
      embeddings,
      MODEL,
      false,
      async () => undefined,
    );
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(db.listVectorsPage(MODEL, 0, 10)).toEqual([]);
    db.close();
  });

  it("a local model embeds local-only items in their own local-only call", async () => {
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
    const embeddings = fakeEmbeddings(oneVector);
    await embedPending(db, embeddings, MODEL, true, async () => undefined);
    // A local model receives the item, and core's gate sees the class.
    expect(embeddings.embed).toHaveBeenCalledWith(
      ["the harbourside bakery sells bread"],
      { confidentiality: "local-only", model: MODEL },
    );
    expect(db.listVectorsPage(MODEL, 0, 10)).toHaveLength(1);
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
    const embeddings = fakeEmbeddings(oneVector);
    await embedPending(
      db,
      embeddings,
      MODEL,
      false,
      async () => undefined,
    );
    expect(embeddings.embed).toHaveBeenCalledWith(
      ["the harbourside bakery sells bread"],
      { confidentiality: "normal", model: MODEL },
    );
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
