import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EntryRecord } from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import { describe, expect, it } from "vitest";

import { RecallDb, type ItemRow } from "../src/db.js";
import createRecall from "../src/index.js";
import type { EmbeddingModelRow } from "../src/vectors.js";
import { withDeclaredSettings } from "./fake-host.js";
import {
  createSearcher,
  type SearchContext,
  type Searcher,
} from "../src/search.js";
import type { InContextRule } from "../src/sittings/lineage.js";

const NOW = 1_700_000_000_000;

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    pinned: false,
    tagged: [],
    archived: false,
    draft: { text: "", attachments: [] },
    source: "test",
    owner: "alice",
    ...overrides,
  };
}

function entry(id: number, conversationId: number, text: string): EntryRecord {
  return {
    id,
    conversationId,
    kind: "pi.message",
    model: [{ role: "user", content: text, timestamp: NOW }],
  } as unknown as EntryRecord;
}

function item(
  overrides: Partial<Omit<ItemRow, "id">> = {},
): Omit<ItemRow, "id"> {
  return {
    conversationId: 1,
    owner: "alice",
    kind: "turn",
    entryId: 1,
    messageIndex: 0,
    blockIndex: 0,
    offset: 0,
    length: 100,
    artifact: null,
    doc: null,
    job: false,
    cls: "normal",
    at: NOW,
    title: "captured title",
    ...overrides,
  };
}

function context(overrides: Partial<SearchContext> = {}): SearchContext {
  return {
    current: { conversationId: 1, owner: "alice" },
    model: { provider: "acme-local", id: "chat-1" },
    includeJobs: false,
    ...overrides,
  };
}

function setup(
  text: string,
  options: {
    item?: Partial<Omit<ItemRow, "id">>;
    meta?: SessionMeta;
    localModels?: string[];
    now?: number;
  } = {},
): { db: RecallDb; searcher: Searcher; metas: Map<number, SessionMeta> } {
  const db = RecallDb.open(":memory:");
  const row = item(options.item);
  db.insertItem(row, text);
  const conversationId = row.conversationId ?? 1;
  const metas = new Map<number, SessionMeta>([
    [conversationId, options.meta ?? meta()],
  ]);
  const entries = new Map<string, EntryRecord>([
    [
      `${conversationId}:${row.entryId}`,
      entry(row.entryId!, conversationId, text),
    ],
  ]);
  const searcher = createSearcher({
    db,
    meta: async (id) => {
      const value = metas.get(id);
      if (value === undefined) throw new Error("deleted conversation");
      return value;
    },
    entry: async (conversationId, entryId) =>
      entries.get(`${conversationId}:${entryId}`),
    isLocal: (model) =>
      (options.localModels ?? ["acme-local/chat-1"]).includes(model),
    now: () => options.now ?? NOW,
  });
  return { db, searcher, metas };
}

interface PerUserSearchOptions {
  bobDefault: string;
  bobVector: string;
  concurrent: boolean;
}

/** Drive the production route with two owners and two distinct vector spaces. */
async function perUserSearch(options: PerUserSearchOptions) {
  const root = await mkdtemp(join(tmpdir(), "recall-search-owner-"));
  const ALICE_MODEL = "acme-embed/alice";
  const BOB_MODEL = "acme-embed/bob";
  const SYSTEM_MODEL = "acme-embed/system";
  const db = RecallDb.open(join(root, "recall.db"));
  for (const [conversationId, owner, text] of [
    [1, "alice", "first owner's private note"],
    [2, "bob", "second owner's private note"],
  ] as const) {
    const id = db.insertItem(
      {
        conversationId,
        owner,
        kind: "turn",
        entryId: 1,
        messageIndex: 0,
        blockIndex: 0,
        offset: 0,
        length: text.length,
        artifact: null,
        doc: null,
        job: false,
        cls: "normal",
        at: NOW,
        title: null,
      },
      text,
    );
    const model = owner === "alice" ? ALICE_MODEL : options.bobVector;
    // Only that owner's item has a vector in this space. An unscoped index
    // therefore cannot accidentally produce the same hit.
    db.upsertVector(id!, model, new Float32Array([1]));
  }
  db.close();

  const records = [
    entry(1, 1, "first owner's private note"),
    entry(1, 2, "second owner's private note"),
  ];
  const listUsers: (string | undefined)[] = [];
  const embedCalls: { user?: string; model?: string }[] = [];
  let releaseAlice: (() => void) | undefined;
  const aliceGate = new Promise<void>((resolve) => {
    releaseAlice = resolve;
  });
  const result = await createRecall(
    withDeclaredSettings({
      stores: {
        paths: { data: root },
        settings: { get: async () => ({}) },
        user: () => ({ settings: { get: async () => ({}) } }),
      },
      users: { list: async () => [] },
      conversations: {
        meta: async (id: number) => meta({ owner: id === 1 ? "alice" : "bob" }),
        entry: async (id: number, entryId: number) =>
          records.find((record) => record.conversationId === id && record.id === entryId),
      },
      embeddings: {
        list: async (opts?: { user?: string }) => {
          listUsers.push(opts?.user);
          let current = SYSTEM_MODEL;
          if (opts?.user === "alice") current = ALICE_MODEL;
          if (opts?.user === "bob") current = options.bobDefault;
          return [ALICE_MODEL, BOB_MODEL, SYSTEM_MODEL].map((model): EmbeddingModelRow => ({
            model,
            provider: "acme-embed",
            dimensions: 1,
            local: false,
            default: model === current,
            status: "ready",
          }));
        },
        embed: async (texts: readonly string[], opts?: { user?: string; model?: string }) => {
          embedCalls.push({ user: opts?.user, model: opts?.model });
          if (options.concurrent && opts?.user === "alice") await aliceGate;
          return {
            ok: true as const,
            model: opts?.model ?? SYSTEM_MODEL,
            dimensions: 1,
            vectors: texts.map(() => new Float32Array([1])),
          };
        },
      },
    } as unknown as SigrunHost),
  );
  const route = result.routes!.find((candidate) => candidate.path === "search")!;
  const search = async (user: string) => {
    const response = await route.handler(
      new Request("https://example.invalid/search?q=semantic+match"),
      { principal: { user, admin: false } } as never,
    );
    return (await response.json()) as { hits: { conversationId: number }[] };
  };
  return {
    result,
    search,
    listUsers,
    embedCalls,
    releaseAlice: () => releaseAlice?.(),
    close: async () => {
      await result.harnessShutdown?.({} as never, {} as never);
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("search", () => {
  it("inContext filters only material already visible in the current sitting", async () => {
    const db = RecallDb.open(":memory:");
    db.insertItem(item({ entryId: 39, at: 3_900 }), "pre-boundary clinic");
    db.insertItem(item({ entryId: 40, at: 4_000 }), "boundary clinic");
    const searcher = createSearcher({
      db,
      meta: async () => meta(),
      entry: async (_conversationId, entryId) =>
        entry(entryId, 1, entryId === 39 ? "pre-boundary clinic" : "boundary clinic"),
      isLocal: () => false,
      now: () => NOW,
    });
    const inContextRule: InContextRule = {
      lineage: [
        {
          conversationId: 1,
          throughEntryId: Number.POSITIVE_INFINITY,
          throughAt: Number.POSITIVE_INFINITY,
        },
      ],
      boundary: { entryId: 40, at: 4_000 },
    };
    const hits = await searcher.search(
      "clinic",
      context({ inContext: inContextRule }),
      10,
    );
    expect(hits.map((hit) => hit.item.entryId)).toEqual([39]);
    db.close();
  });

  it("excludeConversation still suppresses the whole conversation when inContext is present", async () => {
    const { searcher } = setup("clinic");
    expect(
      await searcher.search(
        "clinic",
        context({
          excludeConversation: 1,
          inContext: {
            lineage: [
              {
                conversationId: 1,
                throughEntryId: Number.POSITIVE_INFINITY,
                throughAt: Number.POSITIVE_INFINITY,
              },
            ],
            boundary: { entryId: 40, at: 4_000 },
          },
        }),
        10,
      ),
    ).toEqual([]);
  });

  it("concurrent searches use each caller's model", async () => {
    const rig = await perUserSearch({
      bobDefault: "acme-embed/bob",
      bobVector: "acme-embed/bob",
      concurrent: true,
    });
    try {
      const alice = rig.search("alice");
      // Alice is now inside her gated embedding call. Bob must still resolve
      // and embed under BOB_MODEL, and must match only his own vector.
      const bob = await rig.search("bob");
      expect(bob.hits.map((hit) => hit.conversationId)).toEqual([2]);
      expect(rig.embedCalls.find((call) => call.user === "bob")?.model).toBe("acme-embed/bob");
      rig.releaseAlice();
      const aliceBody = await alice;
      expect(aliceBody.hits.map((hit) => hit.conversationId)).toEqual([1]);
      expect(rig.embedCalls.find((call) => call.user === "alice")?.model).toBe("acme-embed/alice");
    } finally {
      rig.releaseAlice();
      await rig.close();
    }
  });

  it("a user with no override shares the system model's vectors", async () => {
    const rig = await perUserSearch({
      bobDefault: "acme-embed/system",
      bobVector: "acme-embed/system",
      concurrent: false,
    });
    try {
      const body = await rig.search("bob");
      expect(body.hits.map((hit) => hit.conversationId)).toEqual([2]);
      expect(rig.listUsers).toContain("bob");
      expect(rig.embedCalls).toContainEqual({ user: "bob", model: "acme-embed/system" });
    } finally {
      await rig.close();
    }
  });

  it('finds a past turn by a stemmed word ("clinics" matches "clinic")', async () => {
    const { searcher } = setup("the clinic is open");
    expect(await searcher.search("clinics", context(), 10)).toHaveLength(1);
  });

  it('finds a substring with trigram ("lectric" finds "electrician")', async () => {
    const { searcher } = setup("call the electrician");
    expect(await searcher.search("lectric", context(), 10)).toHaveLength(1);
  });

  it('CJK text "東京の獣医" is found by the 3-char substring "京の獣"', async () => {
    const { searcher } = setup("東京の獣医");
    expect(await searcher.search("京の獣", context(), 10)).toHaveLength(1);
  });

  it('a 2-char CJK query ("獣医") returns no trigram hits and does not throw', async () => {
    const { searcher } = setup("東京の獣医");
    expect(await searcher.search("獣医", context(), 10)).toEqual([]);
  });

  it("inside alice's conversation shared with bob, alice's private conversation never appears", async () => {
    const { searcher } = setup("private clinic");
    const sharedCurrent = context({
      current: {
        conversationId: 2,
        owner: "alice",
        sharing: { scope: "people", users: ["bob"], level: "read" },
      },
    });
    expect(await searcher.search("clinic", sharedCurrent, 10)).toEqual([]);
  });

  it("an item from a conversation unshared after capture stops matching on the next search", async () => {
    const { searcher, metas } = setup("shared clinic", {
      meta: meta({
        owner: "alice",
        sharing: { scope: "people", users: ["bob"], level: "read" },
      }),
    });
    const asBob = context({ current: { conversationId: 2, owner: "bob" } });
    expect(await searcher.search("clinic", asBob, 10)).toHaveLength(1);
    metas.set(1, meta({ owner: "alice", sharing: { scope: "private" } }));
    expect(await searcher.search("clinic", asBob, 10)).toEqual([]);
  });

  it("a local-only item is returned only when the admin marks its full model id local", async () => {
    const { searcher } = setup("local clinic", {
      item: { cls: "local-only" },
      localModels: ["acme-local/chat-1"],
    });
    expect(await searcher.search("clinic", context(), 10)).toHaveLength(1);
    expect(
      await searcher.search(
        "clinic",
        context({ model: { provider: "acme-cloud", id: "chat-1" } }),
        10,
      ),
    ).toEqual([]);
  });

  it("deleted conversations are not searchable", async () => {
    const { searcher, metas } = setup("clinic");
    metas.set(1, meta({ deleted: true }));
    expect(await searcher.search("clinic", context(), 10)).toEqual([]);
  });

  it("archived conversations stay searchable", async () => {
    const { searcher, metas } = setup("clinic");
    metas.set(1, meta({ archived: true }));
    expect(await searcher.search("clinic", context(), 10)).toHaveLength(1);
  });

  it("job items are excluded unless includeJobs", async () => {
    const { searcher } = setup("job clinic", { item: { job: true } });
    expect(await searcher.search("clinic", context(), 10)).toEqual([]);
    expect(
      await searcher.search("clinic", context({ includeJobs: true }), 10),
    ).toHaveLength(1);
  });

  it("an item owned by a user absent from the directory is still searchable (normal class) and the search does not throw", async () => {
    const db = RecallDb.open(":memory:");
    db.insertItem(item(), "clinic");
    const searcher = createSearcher({
      db,
      meta: async () => meta(),
      entry: async () => entry(1, 1, "clinic"),
      isLocal: () => false,
      now: () => NOW,
    });
    expect(await searcher.search("clinic", context(), 10)).toHaveLength(1);
    db.close();
  });

  it("conversationTitle reflects a rename made after capture", async () => {
    const { searcher, metas } = setup("clinic");
    metas.set(1, meta({ name: "Renamed conversation" }));
    const hits = await searcher.search("clinic", context(), 10);
    expect(hits[0]?.conversationTitle).toBe("Renamed conversation");
  });

  it("a newer item outranks an equally matching older one", async () => {
    const db = RecallDb.open(":memory:");
    db.insertItem(item({ at: NOW - 86_400_000 * 365 }), "clinic");
    db.insertItem(item({ entryId: 2, at: NOW }), "clinic");
    const searcher = createSearcher({
      db,
      meta: async () => meta(),
      entry: async (_conversationId, entryId) => entry(entryId, 1, "clinic"),
      isLocal: () => false,
      now: () => NOW,
    });
    const hits = await searcher.search("clinic", context(), 10);
    expect(hits.map((hit) => hit.item.entryId)).toEqual([2, 1]);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('FTS syntax in the query ("a OR b NEAR(c") does not throw', async () => {
    const { searcher } = setup("clinic");
    expect(await searcher.search("a OR b NEAR(c", context(), 10)).toEqual([]);
  });

  it("alice's record surfaces in her private conversation with a d: handle, her record's title and a doc snippet", async () => {
    const db = RecallDb.open(":memory:");
    const stored = db.upsertDoc(
      {
        provider: "acme-local",
        docId: "d1",
        owner: "alice",
        kind: "record",
        title: "Northside Vet research",
        url: null,
        at: NOW,
        cls: "normal",
        text: "the harbourside bakery sells bread",
        sources: [],
      },
      NOW,
    );
    const searcher = createSearcher({
      db,
      meta: async () => meta(),
      entry: async () => undefined,
      isLocal: (model) => model === "acme-local/chat-1",
      now: () => NOW,
    });
    const hits = await searcher.search("harbourside", context(), 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.handle).toBe(`d:${stored.id}`);
    expect(hits[0]?.conversationTitle).toBe("Northside Vet research");
    expect(hits[0]?.snippet).toContain("harbourside");
    expect(hits[0]?.item.at).toBe(NOW);
    db.close();
  });

  it("alice's record never surfaces in alice's conversation shared with bob", async () => {
    const db = RecallDb.open(":memory:");
    db.upsertDoc(
      {
        provider: "acme-local",
        docId: "d1",
        owner: "alice",
        kind: "record",
        title: "Northside Vet research",
        url: null,
        at: NOW,
        cls: "normal",
        text: "the harbourside bakery sells bread",
        sources: [],
      },
      NOW,
    );
    const searcher = createSearcher({
      db,
      meta: async () => meta(),
      entry: async () => undefined,
      isLocal: (model) => model === "acme-local/chat-1",
      now: () => NOW,
    });
    const sharedWithBob = context({
      current: {
        conversationId: 2,
        owner: "alice",
        sharing: { scope: "people", users: ["bob"], level: "read" },
      },
    });
    expect(await searcher.search("harbourside", sharedWithBob, 10)).toEqual([]);
    const asBob = context({ current: { conversationId: 3, owner: "bob" } });
    expect(await searcher.search("harbourside", asBob, 10)).toEqual([]);
    db.close();
  });

  it("a local-only doc is withheld from a non-local model and shown to a local one", async () => {
    const db = RecallDb.open(":memory:");
    db.upsertDoc(
      {
        provider: "acme-local",
        docId: "d1",
        owner: "alice",
        kind: "record",
        title: "Northside Vet research",
        url: null,
        at: NOW,
        cls: "local-only",
        text: "the harbourside bakery sells bread",
        sources: [],
      },
      NOW,
    );
    const searcher = createSearcher({
      db,
      meta: async () => meta(),
      entry: async () => undefined,
      isLocal: (model) => model === "acme-local/chat-1",
      now: () => NOW,
    });
    expect(
      await searcher.search(
        "harbourside",
        context({ model: { provider: "acme-cloud", id: "chat-1" } }),
        10,
      ),
    ).toEqual([]);
    expect(await searcher.search("harbourside", context(), 10)).toHaveLength(1);
    db.close();
  });
});
