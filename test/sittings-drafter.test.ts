import type { ConversationId, Cursor, EntryRecord } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import { afterEach, describe, expect, it } from "vitest";

import { RecallDb } from "../src/db.js";
import {
  LINE_PROMPT,
  MONTH_PROMPT,
  createSittingDrafter,
} from "../src/sittings/drafter.js";
import { TOC_BUDGET_BYTES } from "../src/sittings/toc.js";
import type { SittingRow } from "../src/sittings/types.js";

const T0 = Date.UTC(2026, 0, 5); // 2026-01-05
const DEC = Date.UTC(2025, 11, 20);

const openDatabases: RecallDb[] = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) db.close();
});

function memoryDb(): RecallDb {
  const db = RecallDb.open(":memory:");
  openDatabases.push(db);
  return db;
}

function userMessage(text: string, timestamp = T0): Message {
  return { role: "user", content: text, timestamp };
}

function assistantMessage(text: string, timestamp = T0 + 1000): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "acme-local",
    model: "chat-1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as Message;
}

function entry(
  id: number,
  kind: string,
  message?: Message,
): EntryRecord {
  return {
    id,
    conversationId: 1,
    kind,
    model: message === undefined ? undefined : [message],
  } as unknown as EntryRecord;
}

interface FakeHost {
  host: Pick<SigrunHost, "conversations" | "models">;
  calls: { role?: string; systemPrompt?: string; prompt: string; timeoutMs?: number }[];
  entryReads: {
    query: { minEntryId?: number; order: "ascending" | "descending" };
    limit: number;
    cursor?: Cursor;
  }[];
}

function fakeHost(
  meta: Partial<SessionMeta>,
  entries: readonly EntryRecord[],
  respond?: (prompt: string) => string,
): FakeHost {
  const calls: FakeHost["calls"] = [];
  const entryReads: FakeHost["entryReads"] = [];
  const host = {
    conversations: {
      meta: async () => meta as SessionMeta,
      entries: async (
        _id: ConversationId,
        query: { minEntryId?: number; order: "ascending" | "descending" },
        limit: number,
        cursor?: Cursor,
      ) => {
        entryReads.push({
          query: Object.fromEntries(
            Object.entries(query).filter(([, value]) => value !== undefined),
          ) as FakeHost["entryReads"][number]["query"],
          limit,
          cursor,
        });
        const offset = cursor === undefined ? 0 : Number(cursor);
        const filtered = entries.filter(
          (candidate) =>
            query.minEntryId === undefined || candidate.id >= query.minEntryId,
        );
        const ordered = query.order === "descending"
          ? [...filtered].reverse()
          : filtered;
        const items = ordered.slice(offset, offset + limit);
        const nextOffset = offset + items.length;
        return {
          items,
          next: nextOffset < ordered.length ? nextOffset : undefined,
        };
      },
    },
    models: {
      complete: async (input: { role?: string; systemPrompt?: string; prompt: string; timeoutMs?: number }) => {
        calls.push(input);
        return { text: respond?.(input.prompt) ?? "Drafted line.", model: "acme-local/chat-1" };
      },
    },
  } as unknown as FakeHost["host"];
  return { host, calls, entryReads };
}

function sitting(overrides: Partial<SittingRow> = {}): SittingRow {
  return {
    conversationId: 1,
    startEntryId: 1,
    startAt: T0,
    boundary: false,
    boundaryText: "What about the garden?",
    previous: null,
    block: null,
    title: null,
    titleState: "none",
    ...overrides,
  };
}

function deps(
  db: RecallDb,
  fake: FakeHost,
  enabled = true,
  now = T0 + 60_000,
) {
  return {
    db: () => db,
    host: fake.host,
    userEnabled: async () => enabled,
    now: () => now,
  };
}

const basicEntries = [
  entry(1, "pi.user", userMessage("What about the garden?")),
  entry(2, "pi.assistant", assistantMessage("Plant tomatoes.")),
  entry(3, "pi.user", userMessage("When?", T0 + 2000)),
  entry(4, "pi.assistant", assistantMessage("In spring.", T0 + 3000)),
];

const CONVERSATION = 1 as ConversationId;

function idleWake() {
  return { event: "conversationIdle", conversationId: CONVERSATION };
}

describe("sitting drafter", () => {
  it("drafts the open sitting's line with the utility model", async () => {
    const db = memoryDb();
    const fake = fakeHost({}, basicEntries);
    const worker = createSittingDrafter(deps(db, fake));

    expect(worker.name).toBe("sittings");
    expect(worker.wakeOn).toEqual(["conversationIdle"]);

    await worker.run({ abortSignal: undefined }, idleWake());

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      role: "utility",
      systemPrompt: LINE_PROMPT,
      timeoutMs: 60_000,
    });
    expect(fake.calls[0]!.prompt).toContain("What about the garden?");
    expect(fake.calls[0]!.prompt).toContain("Plant tomatoes.");

    const sittings = db.sittings([1]);
    expect(sittings).toHaveLength(1);
    expect(sittings[0]).toMatchObject({
      startEntryId: 1,
      startAt: T0,
      boundary: false,
      titleState: "none",
    });

    const lines = db.lines([1]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      startEntryId: 1,
      text: "Drafted line.",
      cls: "normal",
      coversThrough: 4,
      sealed: false,
    });
  });

  it("a local-only sitting never calls the model", async () => {
    const db = memoryDb();
    db.setTaint(1, 3);
    const fake = fakeHost({}, basicEntries);
    const worker = createSittingDrafter(deps(db, fake));

    await worker.run({ abortSignal: undefined }, idleWake());

    expect(fake.calls).toHaveLength(0);
    const lines = db.lines([1]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ cls: "local-only", coversThrough: 4 });
    expect(lines[0]!.text).toBe("What about the garden?");
  });

  it("a completion failure stores the fallback", async () => {
    const db = memoryDb();
    const fake = fakeHost({}, basicEntries);
    fake.host.models.complete = async () => {
      throw new Error("no model");
    };
    const worker = createSittingDrafter(deps(db, fake));

    await worker.run({ abortSignal: undefined }, idleWake());

    const lines = db.lines([1]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      text: "What about the garden?",
      cls: "normal",
      coversThrough: 4,
    });
  });

  it("a sealed line is never redrafted", async () => {
    const db = memoryDb();
    db.putSitting(sitting());
    db.sealLine(1, 1, { text: "Sealed.", cls: "normal", coversThrough: 2 });
    const fake = fakeHost({}, basicEntries);
    const worker = createSittingDrafter(deps(db, fake));

    await worker.run({ abortSignal: undefined }, idleWake());

    expect(fake.calls).toHaveLength(0);
    expect(db.lines([1])[0]).toMatchObject({ text: "Sealed.", sealed: true });
  });

  it("an up-to-date draft is not redrafted", async () => {
    const db = memoryDb();
    db.putSitting(sitting());
    db.putLineDraft({
      conversationId: 1,
      startEntryId: 1,
      text: "Current.",
      cls: "normal",
      coversThrough: 4,
    });
    const fake = fakeHost({}, basicEntries);
    const worker = createSittingDrafter(deps(db, fake));

    await worker.run({ abortSignal: undefined }, idleWake());

    expect(fake.calls).toHaveLength(0);
    expect(db.lines([1])[0]).toMatchObject({ text: "Current." });
  });

  it("cron, internal and job conversations are skipped", async () => {
    for (const meta of [
      { source: "cron" },
      { internal: true as const },
      { jobId: "job-1" },
    ]) {
      const db = memoryDb();
      const fake = fakeHost(meta, basicEntries);
      const worker = createSittingDrafter(deps(db, fake));

      await worker.run({ abortSignal: undefined }, idleWake());

      expect(fake.calls).toHaveLength(0);
      expect(db.sittings([1])).toHaveLength(0);
      expect(db.lines([1])).toHaveLength(0);
    }
  });

  it("a disabled user is skipped", async () => {
    const db = memoryDb();
    const fake = fakeHost({ owner: "alice" }, basicEntries);
    const worker = createSittingDrafter(deps(db, fake, false));

    await worker.run({ abortSignal: undefined }, idleWake());

    expect(fake.calls).toHaveLength(0);
    expect(db.sittings([1])).toHaveLength(0);
  });

  it("an empty conversation does nothing", async () => {
    const db = memoryDb();
    const fake = fakeHost({}, []);
    const worker = createSittingDrafter(deps(db, fake));

    await worker.run({ abortSignal: undefined }, idleWake());

    expect(fake.calls).toHaveLength(0);
    expect(db.sittings([1])).toHaveLength(0);
  });

  it("collapses the oldest complete month once over budget, once", async () => {
    const db = memoryDb();
    // One open sitting in the current month (January 2026).
    db.putSitting(sitting({ startEntryId: 90, startAt: T0 }));
    db.putLineDraft({
      conversationId: 1,
      startEntryId: 90,
      text: "Open line.",
      cls: "normal",
      coversThrough: 4,
    });
    // Many sealed sittings in December 2025, over the budget.
    let id = 10;
    for (let index = 0; index < 40; index += 1) {
      db.putSitting(
        sitting({
          startEntryId: id,
          startAt: DEC + index * 3_600_000,
          boundary: true,
          title: `Sitting ${index}`,
        }),
      );
      db.sealLine(1, id, {
        text: `Sitting ${index}: ${"a fair amount of detail ".repeat(6)}`,
        cls: "normal",
        coversThrough: id + 1,
      });
      id += 2;
    }
    expect(db.monthLines([1])).toHaveLength(0);

    const fake = fakeHost({}, basicEntries, () => "December in one line.");
    const worker = createSittingDrafter(deps(db, fake));

    await worker.run({ abortSignal: undefined }, idleWake());

    const months = db.monthLines([1]);
    expect(months).toHaveLength(1);
    expect(months[0]).toMatchObject({
      month: "2025-12",
      text: "December in one line.",
      cls: "normal",
    });
    const monthCall = fake.calls.find(
      (call) => call.systemPrompt === MONTH_PROMPT,
    );
    expect(monthCall).toBeDefined();
    expect(monthCall!.prompt).toContain("Sitting 0");
    expect(monthCall!.prompt).toContain("Sitting 39");

    // A second wake collapses nothing more.
    const callsBefore = fake.calls.length;
    await worker.run({ abortSignal: undefined }, idleWake());
    expect(db.monthLines([1])).toHaveLength(1);
    expect(fake.calls.length).toBe(callsBefore);
  });

  it("a month with any local-only line collapses without a model call", async () => {
    const db = memoryDb();
    db.putSitting(sitting({ startEntryId: 90, startAt: T0 }));
    db.putLineDraft({
      conversationId: 1,
      startEntryId: 90,
      text: "Open line.",
      cls: "normal",
      coversThrough: 4,
    });
    let id = 10;
    for (let index = 0; index < 40; index += 1) {
      db.putSitting(
        sitting({
          startEntryId: id,
          startAt: DEC + index * 3_600_000,
          boundary: true,
          title: `Sitting ${index}`,
        }),
      );
      db.sealLine(1, id, {
        text: `Sitting ${index}: ${"a fair amount of detail ".repeat(6)}`,
        cls: index === 0 ? "local-only" : "normal",
        coversThrough: id + 1,
      });
      id += 2;
    }

    const fake = fakeHost({}, basicEntries);
    const worker = createSittingDrafter(deps(db, fake));

    await worker.run({ abortSignal: undefined }, idleWake());

    const months = db.monthLines([1]);
    expect(months).toHaveLength(1);
    expect(months[0]!.cls).toBe("local-only");
    expect(months[0]!.text).toContain("Sitting 0");
    expect(months[0]!.text).toContain("; ");
    expect(
      fake.calls.find((call) => call.systemPrompt === MONTH_PROMPT),
    ).toBeUndefined();
  });

  it("a failed month completion writes nothing and the next wake retries", async () => {
    const db = memoryDb();
    db.putSitting(sitting({ startEntryId: 90, startAt: T0 }));
    db.putLineDraft({
      conversationId: 1,
      startEntryId: 90,
      text: "Open line.",
      cls: "normal",
      coversThrough: 4,
    });
    let id = 10;
    for (let index = 0; index < 40; index += 1) {
      db.putSitting(
        sitting({
          startEntryId: id,
          startAt: DEC + index * 3_600_000,
          boundary: true,
          title: `Sitting ${index}`,
        }),
      );
      db.sealLine(1, id, {
        text: `Sitting ${index}: ${"a fair amount of detail ".repeat(6)}`,
        cls: "normal",
        coversThrough: id + 1,
      });
      id += 2;
    }

    const fake = fakeHost({}, basicEntries, () => "December in one line.");
    const originalComplete = fake.host.models.complete;
    let failMonth = true;
    fake.host.models.complete = async (input) => {
      if (input.systemPrompt === MONTH_PROMPT && failMonth) {
        throw new Error("month model unavailable");
      }
      return originalComplete(input);
    };
    const worker = createSittingDrafter(deps(db, fake));

    await worker.run({ abortSignal: undefined }, idleWake());
    expect(db.monthLines([1])).toHaveLength(0);

    failMonth = false;
    await worker.run({ abortSignal: undefined }, idleWake());
    expect(db.monthLines([1])).toHaveLength(1);
    expect(db.monthLines([1])[0]).toMatchObject({
      month: "2025-12",
      text: "December in one line.",
      cls: "normal",
    });
  });

  it("stops collapsing when a month line does not reduce the table bytes", async () => {
    const db = memoryDb();
    db.putSitting(sitting({ startEntryId: 90, startAt: T0 }));
    db.putLineDraft({
      conversationId: 1,
      startEntryId: 90,
      text: "Open line.",
      cls: "normal",
      coversThrough: 4,
    });
    let id = 10;
    for (const [monthIndex, month] of ["2025-11", "2025-12"].entries()) {
      const start = Date.UTC(2025, 10 + monthIndex, 1);
      for (let index = 0; index < 40; index += 1) {
        db.putSitting(
          sitting({
            startEntryId: id,
            startAt: start + index * 3_600_000,
            boundary: true,
            title: `${month} sitting ${index}`,
          }),
        );
        db.sealLine(1, id, {
          text: `${month} sitting ${index}: ${"a fair amount of detail ".repeat(6)}`,
          cls: "normal",
          coversThrough: id + 1,
        });
        id += 2;
      }
    }

    const fake = fakeHost({}, basicEntries, () => "x".repeat(20_000));
    const worker = createSittingDrafter(deps(db, fake));

    await worker.run({ abortSignal: undefined }, idleWake());

    expect(db.monthLines([1])).toHaveLength(1);
    expect(db.monthLines([1])[0]!.month).toBe("2025-11");
    expect(
      fake.calls.filter((call) => call.systemPrompt === MONTH_PROMPT),
    ).toHaveLength(1);
  });

  it("reads the latest entry and only the newest sitting range", async () => {
    const db = memoryDb();
    db.putSitting(sitting({ startEntryId: 3, startAt: T0 + 2000 }));
    const fake = fakeHost({}, basicEntries);
    const worker = createSittingDrafter(deps(db, fake));

    await worker.run({ abortSignal: undefined }, idleWake());

    expect(fake.entryReads).toEqual([
      {
        query: { order: "descending" },
        limit: 1,
        cursor: undefined,
      },
      {
        query: { order: "ascending", minEntryId: 3 },
        limit: 200,
        cursor: undefined,
      },
    ]);
    expect(db.lines([1])[0]).toMatchObject({
      startEntryId: 3,
      coversThrough: 4,
    });
    expect(db.sittings([1])).toHaveLength(1);
  });

  it("reads one ascending page to establish the first sitting", async () => {
    const db = memoryDb();
    const fake = fakeHost({}, basicEntries);
    const worker = createSittingDrafter(deps(db, fake));

    await worker.run({ abortSignal: undefined }, idleWake());

    expect(fake.entryReads).toEqual([
      {
        query: { order: "descending" },
        limit: 1,
        cursor: undefined,
      },
      {
        query: { order: "ascending" },
        limit: 200,
        cursor: undefined,
      },
      {
        query: { order: "ascending", minEntryId: 1 },
        limit: 200,
        cursor: undefined,
      },
    ]);
    expect(db.sittings([1])).toHaveLength(1);
  });

  it("a small table never collapses", async () => {
    const db = memoryDb();
    db.putSitting(sitting({ startEntryId: 90, startAt: T0 }));
    db.putSitting(sitting({ startEntryId: 10, startAt: DEC, boundary: true }));
    db.putSitting(
      sitting({ startEntryId: 20, startAt: DEC + 3_600_000, boundary: true }),
    );
    db.sealLine(1, 10, { text: "One.", cls: "normal", coversThrough: 11 });
    db.sealLine(1, 20, { text: "Two.", cls: "normal", coversThrough: 21 });

    const fake = fakeHost({}, basicEntries);
    const worker = createSittingDrafter(deps(db, fake));

    await worker.run({ abortSignal: undefined }, idleWake());

    expect(db.monthLines([1])).toHaveLength(0);
    expect(
      fake.calls.find((call) => call.systemPrompt === MONTH_PROMPT),
    ).toBeUndefined();
  });

  it("the drafter prompt is capped", async () => {
    const db = memoryDb();
    const huge = [
      entry(1, "pi.user", userMessage("start ".repeat(4000))),
      entry(2, "pi.assistant", assistantMessage("answer ".repeat(4000))),
    ];
    const fake = fakeHost({}, huge);
    const worker = createSittingDrafter(deps(db, fake));

    await worker.run({ abortSignal: undefined }, idleWake());

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.prompt.length).toBeLessThanOrEqual(6000);
    expect(TOC_BUDGET_BYTES).toBe(3072);
  });
});
