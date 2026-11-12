import { describe, expect, it } from "vitest";

import {
  TOC_BUDGET_BYTES,
  fallbackLine,
  renderToc,
  sealArgs,
  tocBytes,
  tocSnapshot,
} from "../src/sittings/toc.js";
import type { LineRow, MonthLineRow, SittingRow } from "../src/sittings/types.js";

const DAY = 86_400_000;
// 2026-01-05T00:00:00Z
const JAN = Date.UTC(2026, 0, 5);
// 2025-12-20T00:00:00Z
const DEC = Date.UTC(2025, 11, 20);

function sitting(overrides: Partial<SittingRow> = {}): SittingRow {
  return {
    conversationId: 1,
    startEntryId: 10,
    startAt: JAN,
    boundary: true,
    boundaryText: "What about the garden?",
    previous: null,
    block: null,
    title: null,
    titleState: "none",
    ...overrides,
  };
}

function line(overrides: Partial<LineRow> = {}): LineRow {
  return {
    conversationId: 1,
    startEntryId: 10,
    text: "Garden plans were discussed.",
    cls: "normal",
    coversThrough: 20,
    sealed: true,
    ...overrides,
  };
}

function month(overrides: Partial<MonthLineRow> = {}): MonthLineRow {
  return {
    conversationId: 1,
    month: "2025-12",
    text: "A month of garden planning.",
    cls: "normal",
    ...overrides,
  };
}

describe("tocSnapshot", () => {
  it("keeps only sealed lines, ordered by startAt, with sitting titles", () => {
    const sittings = [
      sitting({ startEntryId: 10, startAt: JAN + DAY, title: "Garden" }),
      sitting({ startEntryId: 30, startAt: JAN }),
      sitting({ startEntryId: 50, startAt: JAN + 2 * DAY, title: "Cats" }),
    ];
    const lines = [
      line({ startEntryId: 50, text: "Cat food.", coversThrough: 60 }),
      line({ startEntryId: 30, text: "Unsealed draft.", sealed: false }),
      line({ startEntryId: 10, text: "Planted tomatoes.", coversThrough: 20 }),
    ];

    expect(tocSnapshot(lines, [], sittings)).toEqual([
      {
        startAt: JAN + DAY,
        title: "Garden",
        text: "Planted tomatoes.",
        cls: "normal",
      },
      {
        startAt: JAN + 2 * DAY,
        title: "Cats",
        text: "Cat food.",
        cls: "normal",
      },
    ]);
  });

  it("replaces a month's sitting lines with its month line", () => {
    const sittings = [
      sitting({ startEntryId: 10, startAt: DEC, title: "First" }),
      sitting({ startEntryId: 20, startAt: DEC + DAY, title: "Second" }),
      sitting({ startEntryId: 30, startAt: JAN, title: "Third" }),
    ];
    const lines = [
      line({ startEntryId: 10, text: "December one." }),
      line({ startEntryId: 20, text: "December two." }),
      line({ startEntryId: 30, text: "January one." }),
    ];
    const months = [month({ month: "2025-12", text: "December in summary." })];

    const toc = tocSnapshot(lines, months, sittings);
    expect(toc).toEqual([
      {
        startAt: DEC,
        title: null,
        text: "December in summary.",
        cls: "normal",
        month: "2025-12",
      },
      { startAt: JAN, title: "Third", text: "January one.", cls: "normal" },
    ]);
  });

  it("keeps a local-only month line's class", () => {
    const sittings = [sitting({ startEntryId: 10, startAt: DEC })];
    const lines = [line({ startEntryId: 10, cls: "local-only" })];
    const months = [
      month({ month: "2025-12", text: "Private month.", cls: "local-only" }),
    ];

    const toc = tocSnapshot(lines, months, sittings);
    expect(toc).toHaveLength(1);
    expect(toc[0]).toMatchObject({ cls: "local-only", month: "2025-12" });
  });
});

describe("renderToc", () => {
  const remote = { provider: "acme-cloud", id: "chat-1" };
  const local = { provider: "acme-local", id: "chat-2" };
  const isLocal = (model: string) => model.startsWith("acme-local/");

  it("formats dated entries with and without titles", () => {
    const toc = [
      { startAt: JAN, title: "Garden", text: "Planted tomatoes.", cls: "normal" as const },
      { startAt: JAN + DAY, title: null, text: "Weeded.", cls: "normal" as const },
    ];
    expect(renderToc(toc, remote, isLocal)).toBe(
      "- 2026-01-05 · Garden · Planted tomatoes.\n- 2026-01-06 · Weeded.",
    );
  });

  it("formats month entries by month", () => {
    const toc = [
      {
        startAt: DEC,
        title: null,
        text: "December in summary.",
        cls: "normal" as const,
        month: "2025-12",
      },
    ];
    expect(renderToc(toc, remote, isLocal)).toBe("- 2025-12 · December in summary.");
  });

  it("filters local-only lines for a non-local model and is byte-stable for the same model", () => {
    const toc = [
      { startAt: JAN, title: "Garden", text: "Planted tomatoes.", cls: "normal" as const },
      {
        startAt: JAN + DAY,
        title: null,
        text: "Private medical detail.",
        cls: "local-only" as const,
      },
    ];
    expect(renderToc(toc, remote, isLocal)).toBe(
      "- 2026-01-05 · Garden · Planted tomatoes.",
    );
    const once = renderToc(toc, local, isLocal);
    expect(once).toBe(
      "- 2026-01-05 · Garden · Planted tomatoes.\n- 2026-01-06 · Private medical detail.",
    );
    expect(renderToc(toc, local, isLocal)).toBe(once);
  });

  it("hides local-only lines when no model is given", () => {
    const toc = [
      { startAt: JAN, title: null, text: "Secret.", cls: "local-only" as const },
    ];
    expect(renderToc(toc, undefined, isLocal)).toBe("");
  });

  it("drops the oldest lines over budget and says so", () => {
    const toc = Array.from({ length: 30 }, (_, index) => ({
      startAt: JAN + index * DAY,
      title: null,
      text: `Sitting ${index} ${"detail ".repeat(20)}`.trim(),
      cls: "normal" as const,
    }));
    const rendered = renderToc(toc, remote, isLocal);
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(TOC_BUDGET_BYTES);
    expect(rendered.startsWith("(older sittings are searchable with recall_search)")).toBe(
      true,
    );
    expect(rendered).toContain("Sitting 29");
    expect(rendered).not.toContain("Sitting 0 ");
    expect(rendered).toContain("- 2026-01");
  });

  it("does not add the note when everything fits", () => {
    const toc = [
      { startAt: JAN, title: null, text: "Short.", cls: "normal" as const },
    ];
    expect(renderToc(toc, remote, isLocal)).toBe("- 2026-01-05 · Short.");
  });
});

describe("tocBytes", () => {
  it("counts the untruncated bytes as renderToc would format them", () => {
    const toc = Array.from({ length: 30 }, (_, index) => ({
      startAt: JAN + index * DAY,
      title: null,
      text: `Sitting ${index} ${"detail ".repeat(20)}`.trim(),
      cls: "normal" as const,
    }));
    expect(tocBytes(toc)).toBeGreaterThan(TOC_BUDGET_BYTES);
    const small = [
      { startAt: JAN, title: "Garden", text: "Planted tomatoes.", cls: "normal" as const },
    ];
    expect(tocBytes(small)).toBe(
      Buffer.byteLength("- 2026-01-05 · Garden · Planted tomatoes."),
    );
    expect(
      tocBytes([
        {
          startAt: DEC,
          title: null,
          text: "December.",
          cls: "normal" as const,
          month: "2025-12",
        },
      ]),
    ).toBe(Buffer.byteLength("- 2025-12 · December."));
  });
});

describe("fallbackLine", () => {
  it("collapses whitespace", () => {
    expect(fallbackLine("  What about\n the\tgarden?  ")).toBe("What about the garden?");
  });

  it("truncates to 120 characters on a word boundary", () => {
    const long = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    const result = fallbackLine(long);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result).not.toMatch(/ $/);
    expect(long.startsWith(result)).toBe(true);
    // Cut on a word boundary: the remainder starts with a full word.
    expect(long.slice(result.length)).toMatch(/^ word\d+ /);
  });
});

describe("sealArgs", () => {
  const open = sitting({ startEntryId: 10, boundaryText: "What about the garden?" });

  it("uses the draft when it covers the sitting's latest entry", () => {
    const draft = line({
      startEntryId: 10,
      text: "Drafted line.",
      cls: "local-only",
      coversThrough: 30,
    });
    expect(sealArgs(open, draft, 30, "normal")).toEqual({
      startEntryId: 10,
      line: { text: "Drafted line.", cls: "local-only", coversThrough: 30 },
    });
  });

  it("falls back when the draft does not cover the latest entry", () => {
    const draft = line({ startEntryId: 10, text: "Stale.", coversThrough: 20 });
    expect(sealArgs(open, draft, 30, "local-only")).toEqual({
      startEntryId: 10,
      line: {
        text: "What about the garden?",
        cls: "local-only",
        coversThrough: 30,
      },
    });
  });

  it("falls back when there is no draft", () => {
    expect(sealArgs(open, undefined, 30, "normal")).toEqual({
      startEntryId: 10,
      line: {
        text: "What about the garden?",
        cls: "normal",
        coversThrough: 30,
      },
    });
  });
});
