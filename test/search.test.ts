import type { EntryRecord } from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import { describe, expect, it } from "vitest";

import { RecallDb, type ItemRow } from "../src/db.js";
import {
  createSearcher,
  type SearchContext,
  type Searcher,
} from "../src/search.js";

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
    model: { provider: "acme-local" },
    includeJobs: false,
    ...overrides,
  };
}

function setup(
  text: string,
  options: {
    item?: Partial<Omit<ItemRow, "id">>;
    meta?: SessionMeta;
    localProviders?: readonly string[];
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
    userSettings: async () => ({
      autoRecall: true,
      localProviders: options.localProviders ?? ["acme-local"],
    }),
    now: () => options.now ?? NOW,
  });
  return { db, searcher, metas };
}

describe("search", () => {
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

  it("a local-only item is returned only when ctx.model.provider is in the item owner's localProviders", async () => {
    const { searcher } = setup("local clinic", {
      item: { cls: "local-only" },
      localProviders: ["acme-local"],
    });
    expect(await searcher.search("clinic", context(), 10)).toHaveLength(1);
    expect(
      await searcher.search(
        "clinic",
        context({ model: { provider: "acme-cloud" } }),
        10,
      ),
    ).toEqual([]);
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
      userSettings: async () => {
        throw new Error("unknown user");
      },
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
      userSettings: async () => ({ autoRecall: true, localProviders: [] }),
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
});
