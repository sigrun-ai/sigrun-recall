/**
 * Table-of-contents rendering and sealing. A line sealed after its month's
 * month line was written is folded into that month entry and never appears
 * individually.
 */
import type { Confidentiality } from "../db.js";
import type { LineRow, MonthLineRow, SittingRow, TocEntry } from "./types.js";
export declare const TOC_BUDGET_BYTES = 3072;
/**
 * The table of contents: sealed sitting lines only, ordered by startAt. A
 * month with a month line replaces all of that month's sitting lines with
 * one entry; the month entry's startAt is the earliest line it replaces so
 * ordering against other months stays stable.
 */
export declare function tocSnapshot(lines: readonly LineRow[], months: readonly MonthLineRow[], sittings: readonly SittingRow[]): TocEntry[];
/**
 * Render the table for one model. Entries the model may not read are
 * dropped; when the joined lines exceed the byte budget the oldest entries
 * are dropped and a note (counted inside the budget) points at search.
 */
export declare function renderToc(toc: readonly TocEntry[], model: {
    provider: string;
    id: string;
} | undefined, isLocal: (model: string) => boolean): string;
/** The untruncated byte size of every entry, as renderToc would format them. */
export declare function tocBytes(toc: readonly TocEntry[]): number;
/** The last-resort sitting line: the first user message, trimmed to 120 chars. */
export declare function fallbackLine(boundaryText: string): string;
/** What createBoundary seals: the covering draft, else the fallback. */
export declare function sealArgs(open: SittingRow, line: LineRow | undefined, latestEntryId: number, cls: Confidentiality): {
    startEntryId: number;
    line: {
        text: string;
        cls: Confidentiality;
        coversThrough: number;
    };
};
