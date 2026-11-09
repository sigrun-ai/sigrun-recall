import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Type } from "typebox";
import type { PublishedHookCall } from "@sigrun/sigrun/extension";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it } from "vitest";

import { RecallDb, type ItemRow } from "../src/db.js";
import { createPublishedHooks } from "../src/hooks.js";
import createRecall, { RecallIndexInput } from "../src/index.js";
import { createSearcher } from "../src/search.js";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const DATE = "2026-10-30T09:15:00.000Z";

const roots: string[] = [];
const databases: RecallDb[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
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

function setup(options: { localProviders?: readonly string[] } = {}) {
  const db = RecallDb.open(":memory:");
  databases.push(db);
  const searcher = createSearcher({
    db,
    meta: async () => meta(),
    entry: async () => undefined,
    userSettings: async () => ({
      autoRecall: true,
      localProviders: options.localProviders ?? [],
    }),
    now: () => NOW,
  });
  const hooks = createPublishedHooks({
    db: () => db,
    searcher: () => searcher,
    meta: async () => meta(),
    now: () => NOW,
  });
  const byName = new Map(hooks.map((hook) => [hook.name, hook]));
  return { db, hooks, byName };
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
    length: 27,
    artifact: null,
    doc: null,
    job: false,
    cls: "normal",
    at: NOW,
    title: null,
    ...overrides,
  };
}

function call(overrides: Partial<PublishedHookCall> = {}): PublishedHookCall {
  return {
    caller: "knowledge",
    user: "alice",
    conversationId: undefined,
    abortSignal: undefined,
    ...overrides,
  };
}

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: "k1",
    kind: "record",
    title: "Northside Vet research",
    text: "the harbourside bakery sells bread",
    date: DATE,
    ...overrides,
  };
}

describe("published hooks", () => {
  it("index then search finds the card with a d: handle and its date", async () => {
    const { byName } = setup();
    const indexed = (await byName.get("recall.index")!.run(card(), call())) as {
      handle: string;
      class: string;
      changed: boolean;
    };
    expect(indexed.handle).toMatch(/^d:\d+$/);
    expect(indexed.class).toBe("normal");
    expect(indexed.changed).toBe(true);

    const searched = (await byName
      .get("recall.search")!
      .run({ query: "harbourside" }, call())) as {
      hits: {
        handle: string;
        kind: string;
        title: string;
        date: string;
        snippet: string;
        class: string;
        provider?: string;
        id?: string;
      }[];
    };
    expect(searched.hits).toHaveLength(1);
    expect(searched.hits[0]).toEqual({
      handle: indexed.handle,
      kind: "doc",
      title: "Northside Vet research",
      date: DATE,
      snippet: expect.stringContaining("harbourside"),
      class: "normal",
      provider: "knowledge",
      id: "k1",
    });
  });

  it("index with sources citing a local-only item returns class local-only", async () => {
    const { byName } = setup();
    const local = (await byName
      .get("recall.index")!
      .run(
        card({ id: "k2", class: "local-only", text: "the hidden apothecary recipe" }),
        call(),
      )) as { handle: string; class: string };
    expect(local.class).toBe("local-only");

    const cited = (await byName
      .get("recall.index")!
      .run(
        card({ id: "k3", sources: [local.handle, "d:9999"] }),
        call(),
      )) as { handle: string; class: string };
    // The unknown handle d:9999 is ignored; the local-only source tightens the class.
    expect(cited.class).toBe("local-only");
  });

  it("index with a source citing a tainted r: handle returns class local-only", async () => {
    const { byName, db } = setup();
    const taintedId = db.insertItem(
      item({ cls: "local-only" }),
      "the hidden apothecary recipe",
    )!;
    const cited = (await byName
      .get("recall.index")!
      .run(card({ sources: [`r:${taintedId}`] }), call())) as {
      class: string;
    };
    expect(cited.class).toBe("local-only");
  });

  it("the index input schema rejects a non-ISO date", () => {
    // Same Compile call shape core's registry uses; also pins the root re-export.
    const schema = Compile(Type.Object({ date: RecallIndexInput.properties.date }));
    expect(schema.Check({ date: "not-a-date" })).toBe(false);
    expect(schema.Check({ date: DATE })).toBe(true);
  });

  it("index is idempotent: same payload → changed false", async () => {
    const { byName } = setup();
    const first = (await byName.get("recall.index")!.run(card(), call())) as {
      changed: boolean;
    };
    const second = (await byName.get("recall.index")!.run(card(), call())) as {
      changed: boolean;
    };
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
  });

  it("remove drops it from search", async () => {
    const { byName } = setup();
    await byName.get("recall.index")!.run(card(), call());
    const removed = (await byName
      .get("recall.remove")!
      .run({ id: "k1" }, call())) as { removed: boolean };
    expect(removed).toEqual({ removed: true });
    const searched = (await byName
      .get("recall.search")!
      .run({ query: "harbourside" }, call())) as { hits: unknown[] };
    expect(searched.hits).toEqual([]);
    const again = (await byName
      .get("recall.remove")!
      .run({ id: "k1" }, call())) as { removed: boolean };
    expect(again).toEqual({ removed: false });
  });

  it('a second caller extension\'s id "k1" doesn\'t overwrite the first\'s, and each hit\'s provider is its caller\'s slug', async () => {
    const { byName } = setup();
    await byName.get("recall.index")!.run(card(), call());
    await byName
      .get("recall.index")!
      .run(
        card({ title: "Apothecary notes", text: "the harbourside apothecary sells tonics" }),
        call({ caller: "acme-notes" }),
      );
    const searched = (await byName
      .get("recall.search")!
      .run({ query: "harbourside" }, call())) as {
      hits: { title: string; provider?: string; id?: string }[];
    };
    expect(searched.hits).toHaveLength(2);
    const byProvider = new Map(
      searched.hits.map((hit) => [hit.provider, hit]),
    );
    expect(byProvider.get("knowledge")?.title).toBe("Northside Vet research");
    expect(byProvider.get("knowledge")?.id).toBe("k1");
    expect(byProvider.get("acme-notes")?.title).toBe("Apothecary notes");
    expect(byProvider.get("acme-notes")?.id).toBe("k1");
  });

  it("search without a user returns no hits", async () => {
    const { byName } = setup();
    await byName.get("recall.index")!.run(card(), call());
    const searched = (await byName
      .get("recall.search")!
      .run({ query: "harbourside" }, call({ user: undefined }))) as {
      hits: unknown[];
    };
    expect(searched).toEqual({ hits: [] });
  });

  it("search without model returns no local-only items; with alice's local provider it does", async () => {
    const { byName } = setup({ localProviders: ["acme-local"] });
    await byName
      .get("recall.index")!
      .run(card({ class: "local-only" }), call());
    const remote = (await byName
      .get("recall.search")!
      .run({ query: "harbourside" }, call())) as { hits: unknown[] };
    expect(remote.hits).toEqual([]);
    const cloud = (await byName
      .get("recall.search")!
      .run(
        { query: "harbourside", model: { provider: "acme-cloud", modelId: "m1" } },
        call(),
      )) as { hits: unknown[] };
    expect(cloud.hits).toEqual([]);
    const local = (await byName
      .get("recall.search")!
      .run(
        { query: "harbourside", model: { provider: "acme-local", modelId: "m1" } },
        call(),
      )) as { hits: { class: string }[] };
    expect(local.hits).toHaveLength(1);
    expect(local.hits[0]?.class).toBe("local-only");
  });

  it('a call without user throws "recall.index needs a user" (and the same for recall.remove)', async () => {
    const { byName } = setup();
    await expect(
      byName.get("recall.index")!.run(card(), call({ user: undefined })),
    ).rejects.toThrow("recall.index needs a user");
    await expect(
      byName.get("recall.remove")!.run({ id: "k1" }, call({ user: undefined })),
    ).rejects.toThrow("recall.remove needs a user");
  });

  it("the factory result publishes exactly recall.index, recall.remove, recall.search", async () => {
    const root = await mkdtemp(join(tmpdir(), "recall-hooks-"));
    roots.push(root);
    const result = await createRecall({
      stores: {
        paths: { data: root },
        settings: { get: async () => ({}) },
      },
    } as never);
    expect(result.publishedHooks?.map((hook) => hook.name)).toEqual([
      "recall.index",
      "recall.remove",
      "recall.search",
    ]);
  });
});
