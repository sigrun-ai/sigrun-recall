import type { EntryRecord } from "@earendil-works/pi-durable";
import type { EmbeddingResult } from "@sigrun/shared/embeddings";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runSweep } from "../src/backfill.js";
import { captureConversation } from "../src/capture.js";
import { RecallDb } from "../src/db.js";
import createRecall from "../src/index.js";
import type { EmbeddingModelRow } from "../src/vectors.js";
import { withDeclaredSettings } from "./fake-host.js";

const NOW = 1_700_000_000_000;
const OLD_MODEL = "acme-embed/old";
const NEW_MODEL = "acme-embed/new";
const OTHER_MODEL = "acme-embed/other";
const SYSTEM_MODEL = "acme-embed/system";

function entry(id: number, conversationId: number, text: string): EntryRecord {
  return {
    id,
    conversationId,
    kind: "pi.message",
    model: [{ role: "user", content: text, timestamp: NOW }],
  } as unknown as EntryRecord;
}

function host(entries: EntryRecord[], calls: number[] = []): SigrunHost {
  const ids = [...new Set(entries.map((value) => value.conversationId))];
  return {
    conversations: {
      list: async () => ids.map((id) => ({ id })),
      entries: async (
        id: number,
        query: { minEntryId?: number },
        limit: number,
      ) => {
        calls.push(id);
        return {
          items: entries
            .filter((value) => value.conversationId === id)
            .filter(
              (value) =>
                query.minEntryId === undefined || value.id >= query.minEntryId,
            )
            .slice(0, limit),
        };
      },
      meta: async () => ({
        pinned: false,
        tagged: [],
        archived: false,
        draft: { text: "", attachments: [] },
        source: "import",
        owner: "alice",
      }),
    },
  } as unknown as SigrunHost;
}

function deps(hostValue: SigrunHost, db: RecallDb, entryBudget = 2000) {
  return {
    host: hostValue,
    capture: captureConversation,
    db,
    now: () => NOW,
    entryBudget,
  };
}

function embeddingRow(model: string, isDefault: boolean): EmbeddingModelRow {
  return {
    model,
    provider: "acme-embed",
    dimensions: 1,
    local: false,
    default: isDefault,
    status: "ready",
  };
}

interface OwnerSweepOptions {
  defaults: Readonly<Record<string, string>>;
  failModels?: readonly string[];
  vectors?: (db: RecallDb) => void;
  ownerless?: boolean;
}

/** The real factory + backfill route, with per-user model rows and no network. */
async function ownerSweep(options: OwnerSweepOptions) {
  const root = await mkdtemp(join(tmpdir(), "recall-owner-sweep-"));
  let db: RecallDb | undefined;
  const listCalls: ({ user?: string } | undefined)[] = [];
  const embedCalls: { texts: readonly string[]; opts: { model?: string; user?: string } | undefined }[] = [];
  const records = options.ownerless === true
    ? [entry(1, 9, "system note")]
    : [entry(1, 1, "alice note"), entry(2, 2, "bob note")];
  const owners = ["alice", "bob"] as const;
  const result = await createRecall(
    withDeclaredSettings({
      stores: {
        paths: { data: root },
        settings: { get: async () => ({}) },
        user: () => ({ settings: { get: async () => ({}) } }),
      },
      conversations: {
        list: async () => (options.ownerless === true ? [{ id: 9 }] : [{ id: 1 }, { id: 2 }]),
        entries: async (id: number) => ({ items: records.filter((record) => record.conversationId === id) }),
        entry: async (id: number, entryId: number) =>
          records.find((record) => record.conversationId === id && record.id === entryId),
        meta: async (id: number) => ({
          pinned: false,
          tagged: [],
          archived: false,
          draft: { text: "", attachments: [] },
          source: "test",
          owner: options.ownerless === true ? null : owners[id - 1],
        }),
      },
      users: { list: async () => [] },
      embeddings: {
        list: async (opts?: { user?: string }) => {
          listCalls.push(opts);
          const model = options.defaults[opts?.user ?? ""] ?? SYSTEM_MODEL;
          return [
            embeddingRow(OLD_MODEL, false),
            embeddingRow(NEW_MODEL, false),
            embeddingRow(SYSTEM_MODEL, false),
            embeddingRow(OTHER_MODEL, false),
            embeddingRow(model, true),
          ];
        },
        embed: async (texts: readonly string[], opts?: { model?: string; user?: string }): Promise<EmbeddingResult> => {
          embedCalls.push({ texts, opts });
          if (options.failModels?.includes(opts?.model ?? "") === true) {
            return { ok: false, code: "failed", message: "embedding provider unavailable" };
          }
          return {
            ok: true,
            model: opts?.model ?? SYSTEM_MODEL,
            dimensions: 1,
            vectors: texts.map(() => new Float32Array([1])),
          };
        },
      },
    } as unknown as SigrunHost),
    {
      openDb: (path, label) => {
        db = RecallDb.open(path, label);
        options.vectors?.(db);
        return db;
      },
    },
  );
  const backfill = result.routes!.find((route) => route.path === "backfill")!;
  await backfill.handler(new Request("https://example.invalid/backfill", { method: "POST" }), {
    principal: { user: "alice", admin: true },
  } as never);
  return {
    root,
    result,
    db: db!,
    listCalls,
    embedCalls,
    close: async () => {
      await result.harnessShutdown?.({} as never, {} as never);
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("backfill", () => {
  it("each owner's items embed under that owner's model", async () => {
    const sweep = await ownerSweep({ defaults: { alice: OLD_MODEL, bob: NEW_MODEL } });
    try {
      expect(sweep.embedCalls.map((call) => [call.opts?.user, call.opts?.model, call.texts])).toEqual([
        ["alice", OLD_MODEL, ["alice note"]],
        ["bob", NEW_MODEL, ["bob note"]],
      ]);
      expect(sweep.listCalls).toEqual([{ user: "alice" }, { user: "bob" }]);
      expect(sweep.db.listVectorsPage(OLD_MODEL, 0, 10).map((row) => row.itemId)).toEqual([1]);
      expect(sweep.db.listVectorsPage(NEW_MODEL, 0, 10).map((row) => row.itemId)).toEqual([2]);
    } finally {
      await sweep.close();
    }
  });

  it("a switch prunes only that owner's old vectors", async () => {
    const sweep = await ownerSweep({
      defaults: { alice: NEW_MODEL, bob: OTHER_MODEL },
      failModels: [OTHER_MODEL],
      vectors: (db) => {
        for (const itemId of [1, 2]) db.upsertVector(itemId, OLD_MODEL, new Float32Array([1]));
        db.upsertVector(2, NEW_MODEL, new Float32Array([1]));
      },
    });
    try {
      expect(sweep.db.listVectorsPage(NEW_MODEL, 0, 10).map((row) => row.itemId)).toEqual([1, 2]);
      // Alice switched and is complete, so only her OLD vector is pruned.
      // Bob's OTHER model is unavailable: his coverage is incomplete and
      // his OLD fallback must survive Alice's successful switch.
      expect(sweep.db.listVectorsPage(OLD_MODEL, 0, 10).map((row) => row.itemId)).toEqual([2]);
      expect(sweep.db.listVectorsPage(OLD_MODEL, 0, 10, "alice")).toEqual([]);
      expect(sweep.db.listVectorsPage(OLD_MODEL, 0, 10, "bob")).toHaveLength(1);
      expect(sweep.embedCalls.some((call) => call.opts?.user === "bob")).toBe(true);
    } finally {
      await sweep.close();
    }
  });

  it("ownerless items follow the system model", async () => {
    const sweep = await ownerSweep({ defaults: {}, ownerless: true });
    try {
      expect(sweep.db.itemOwners()).toEqual([null]);
      expect(sweep.listCalls).toEqual([undefined]);
      expect(sweep.embedCalls.map((call) => [call.opts?.user, call.opts?.model, call.texts])).toEqual([
        [undefined, SYSTEM_MODEL, ["system note"]],
      ]);
      expect(sweep.db.listVectorsPage(SYSTEM_MODEL, 0, 10, null)).toHaveLength(1);
    } finally {
      await sweep.close();
    }
  });

  it("an unavailable embedding model prunes nothing", async () => {
    const sweep = await ownerSweep({
      defaults: { alice: NEW_MODEL, bob: NEW_MODEL },
      failModels: [NEW_MODEL],
      vectors: (db) => {
        for (const itemId of [1, 2]) db.upsertVector(itemId, OLD_MODEL, new Float32Array([1]));
      },
    });
    try {
      expect(sweep.db.listVectorsPage(OLD_MODEL, 0, 10).map((row) => row.itemId)).toEqual([1, 2]);
      expect(sweep.db.listVectorsPage(NEW_MODEL, 0, 10)).toEqual([]);
    } finally {
      await sweep.close();
    }
  });

  it("backfill indexes a conversation that never had a run settle (an imported one)", async () => {
    const db = RecallDb.open(":memory:");
    const result = await runSweep(
      deps(host([entry(1, 1, "imported clinic")]), db),
    );
    expect(result.indexed).toBe(1);
    expect(db.item(1)).toMatchObject({ conversationId: 1, entryId: 1 });
    db.close();
  });

  it("backfill interrupted mid-conversation and run again leaves exactly one item per passage", async () => {
    const db = RecallDb.open(":memory:");
    const source = host([
      entry(1, 1, "first passage"),
      entry(2, 1, "second passage"),
    ]);
    // Simulate an interrupted capture: entry 1 was committed, entry 2 was not.
    db.insertItem(
      {
        conversationId: 1,
        owner: "alice",
        kind: "turn",
        entryId: 1,
        messageIndex: 0,
        blockIndex: 0,
        offset: 0,
        length: 13,
        artifact: null,
        doc: null,
        job: false,
        cls: "normal",
        at: NOW,
        title: null,
      },
      "first passage",
    );
    db.setCursor(1, 1);
    await runSweep(deps(source, db));
    await runSweep(deps(source, db));
    expect(db.item(1)).toMatchObject({ entryId: 1 });
    expect(db.item(2)).toMatchObject({ entryId: 2 });
    expect(db.item(3)).toBeUndefined();
    db.close();
  });

  it("backfill resumes a conversation whose cursor is mid-transcript, and a caught-up conversation costs one empty read", async () => {
    const db = RecallDb.open(":memory:");
    const calls: number[] = [];
    const source = host([entry(1, 1, "first"), entry(2, 1, "second")], calls);
    db.setCursor(1, 1);
    await runSweep(deps(source, db));
    expect(db.item(1)?.entryId).toBe(2);
    await runSweep(deps(source, db));
    expect(calls.at(-1)).toBe(1);
    db.close();
  });

  it("a per-owner prune leaves other owners' and ownerless vectors intact", () => {
    const db = RecallDb.open(":memory:");
    try {
      for (const [conversationId, owner] of [[1, "alice"], [2, "bob"], [3, null]] as const) {
        db.insertItem(
          {
            conversationId,
            owner,
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
            at: NOW,
            title: null,
          },
          "text",
        );
        db.upsertVector(conversationId, OLD_MODEL, new Float32Array([1]));
        db.upsertVector(conversationId, NEW_MODEL, new Float32Array([1]));
      }

      // SQLite NULL semantics are part of the contract: `owner IS ?` must
      // match the null row too, while `owner = ?` would silently skip it.
      db.deleteVectorsExcept(NEW_MODEL, null);
      expect(db.listVectorsPage(OLD_MODEL, 0, 10).map((row) => row.itemId)).toEqual([1, 2]);
      db.deleteVectorsExcept(NEW_MODEL, "alice");
      expect(db.listVectorsPage(OLD_MODEL, 0, 10).map((row) => row.itemId)).toEqual([2]);
      expect(db.listVectorsPage(NEW_MODEL, 0, 10).map((row) => row.itemId)).toEqual([1, 2, 3]);
    } finally {
      db.close();
    }
  });

  it("backfill wraps around from sweepAfter so every conversation is visited within two runs", async () => {
    const db = RecallDb.open(":memory:");
    const source = host([entry(1, 1, "one"), entry(1, 2, "two")]);
    await runSweep(deps(source, db, 1));
    expect(db.item(1)?.conversationId).toBe(1);
    await runSweep(deps(source, db, 1));
    expect(db.item(2)?.conversationId).toBe(2);
    db.close();
  });
});
