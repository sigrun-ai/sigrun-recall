import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import type { ItemRow } from "../src/db.js";
import {
  inContext,
  loadLineage,
  type EntriesReader,
} from "../src/sittings/lineage.js";

function entry(
  id: number,
  conversationId: number,
  at: number,
): EntryRecord {
  return {
    id,
    conversationId,
    kind: "pi.message",
    model: [{ role: "user", content: `entry ${id}`, timestamp: at }],
  } as unknown as EntryRecord;
}

function reader(entries: readonly EntryRecord[]): {
  read: EntriesReader;
  calls: number;
} {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    read: async (query, limit, cursor) => {
      calls += 1;
      const start = typeof cursor === "number" ? cursor : 0;
      const sorted = [...entries].sort((a, b) =>
        query.order === "ascending" ? a.id - b.id : b.id - a.id,
      );
      const filtered = sorted.filter(
        (value) =>
          (query.minEntryId === undefined || value.id >= query.minEntryId) &&
          (query.maxEntryId === undefined || value.id <= query.maxEntryId),
      );
      const pageItems = filtered.slice(start, start + limit);
      return {
        items: pageItems,
        next:
          start + pageItems.length < filtered.length
            ? start + pageItems.length
            : undefined,
      };
    },
  };
}

function item(overrides: Partial<ItemRow> = {}): ItemRow {
  return {
    id: 1,
    conversationId: 3,
    owner: "alice",
    kind: "turn",
    entryId: 1,
    messageIndex: 0,
    blockIndex: 0,
    offset: 0,
    length: 10,
    artifact: null,
    doc: null,
    job: false,
    cls: "normal",
    at: 1_000,
    title: null,
    ...overrides,
  };
}

function ownLink(conversationId: number) {
  return {
    conversationId,
    throughEntryId: Number.POSITIVE_INFINITY,
    throughAt: Number.POSITIVE_INFINITY,
  };
}

describe("conversation lineage", () => {
  it("a non-fork has only its own link", async () => {
    const source = reader([
      entry(1, 3, 100),
      entry(2, 3, 200),
      entry(3, 3, 300),
    ]);
    const result = await loadLineage(3, source.read);
    expect(result).toEqual([ownLink(3)]);
    expect(source.calls).toBe(1);
    const again = await loadLineage(3, source.read);
    expect(again).toEqual([ownLink(3)]);
    expect(source.calls).toBe(1);
  });

  it("a fork of a fork yields both ancestors with their fork points", async () => {
    const source = reader([
      entry(10, 1, 1_000),
      entry(11, 1, 1_100),
      entry(12, 1, 1_200),
      entry(20, 2, 2_000),
      entry(21, 2, 2_100),
      entry(30, 4, 3_000),
    ]);
    const result = await loadLineage(4, source.read);
    expect(result).toEqual([
      { conversationId: 1, throughEntryId: 12, throughAt: 1_200 },
      { conversationId: 2, throughEntryId: 21, throughAt: 2_100 },
      ownLink(4),
    ]);
  });

  it("memoizes a lineage and pages inherited entries in ascending order", async () => {
    const source = reader([
      entry(1, 1, 100),
      entry(2, 1, 200),
      entry(3, 1, 300),
      entry(4, 2, 400),
    ]);
    const queries: string[] = [];
    const read: EntriesReader = async (query, limit, cursor) => {
      queries.push(query.order);
      return source.read(query, limit, cursor);
    };
    const first = await loadLineage(2, read);
    const second = await loadLineage(2, read);
    expect(first).toBe(second);
    expect(queries).toEqual(["ascending"]);
  });
});

describe("inContext", () => {
  it("no boundary excludes the whole own conversation", () => {
    const rule = { lineage: [ownLink(3)] };
    expect(inContext(item({ entryId: 1 }), rule)).toBe(true);
    expect(inContext(item({ entryId: 100_000 }), rule)).toBe(true);
    expect(inContext(item({ conversationId: 4 }), rule)).toBe(false);
  });

  it("a boundary keeps pre-boundary own items recallable", () => {
    const rule = { lineage: [ownLink(3)], boundary: { entryId: 40, at: 4_000 } };
    expect(inContext(item({ entryId: 39 }), rule)).toBe(false);
    expect(inContext(item({ entryId: 40 }), rule)).toBe(true);
    expect(inContext(item({ entryId: 41 }), rule)).toBe(true);
  });

  it("pre-boundary artifacts are recallable by capture time", () => {
    const rule = { lineage: [ownLink(3)], boundary: { entryId: 40, at: 4_000 } };
    expect(
      inContext(item({ kind: "artifact", entryId: null, at: 3_999 }), rule),
    ).toBe(false);
    expect(
      inContext(item({ kind: "artifact", entryId: null, at: 4_000 }), rule),
    ).toBe(true);
    expect(inContext(item({ entryId: null, at: 4_000 }), rule)).toBe(true);
    expect(inContext(item({ entryId: null, at: 3_999 }), rule)).toBe(false);
  });

  it("ancestor items after the fork point are ordinary other-conversation material", () => {
    const rule = {
      lineage: [
        { conversationId: 1, throughEntryId: 55, throughAt: 5_500 },
        ownLink(3),
      ],
    };
    expect(inContext(item({ conversationId: 1, entryId: 55 }), rule)).toBe(true);
    expect(inContext(item({ conversationId: 1, entryId: 56 }), rule)).toBe(false);
    expect(
      inContext(item({ conversationId: 1, entryId: null, at: 5_500 }), rule),
    ).toBe(true);
    expect(
      inContext(item({ conversationId: 1, entryId: null, at: 5_501 }), rule),
    ).toBe(false);
  });

  it("a fork made mid-sitting inherits the ancestor boundary", () => {
    const rule = {
      lineage: [
        { conversationId: 1, throughEntryId: 55, throughAt: 5_500 },
        ownLink(3),
      ],
      boundary: { entryId: 40, at: 4_000 },
    };
    expect(inContext(item({ conversationId: 1, entryId: 39 }), rule)).toBe(false);
    expect(inContext(item({ conversationId: 1, entryId: 41 }), rule)).toBe(true);
    expect(inContext(item({ conversationId: 1, entryId: 55 }), rule)).toBe(true);
    expect(inContext(item({ conversationId: 1, entryId: 56 }), rule)).toBe(false);
    expect(
      inContext(item({ conversationId: 1, entryId: null, at: 3_999 }), rule),
    ).toBe(false);
    expect(
      inContext(item({ conversationId: 1, entryId: null, at: 4_000 }), rule),
    ).toBe(true);
    expect(
      inContext(item({ conversationId: 1, entryId: null, at: 5_501 }), rule),
    ).toBe(false);
  });
});
