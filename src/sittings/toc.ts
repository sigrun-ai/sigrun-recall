/**
 * Table-of-contents rendering and sealing. A line sealed after its month's
 * month line was written is folded into that month entry and never appears
 * individually.
 */
import type { Confidentiality } from "../db.js";
import { mayRead } from "../policy.js";
import type { LineRow, MonthLineRow, SittingRow, TocEntry } from "./types.js";

export const TOC_BUDGET_BYTES = 3072;

const OLDER_NOTE = "(older sittings are searchable with recall_search)";

function monthOf(at: number): string {
	return new Date(at).toISOString().slice(0, 7);
}

function dayOf(at: number): string {
	return new Date(at).toISOString().slice(0, 10);
}

function formatEntry(entry: TocEntry): string {
	if (entry.month !== undefined) return `- ${entry.month} · ${entry.text}`;
	const date = dayOf(entry.startAt);
	return entry.title === null
		? `- ${date} · ${entry.text}`
		: `- ${date} · ${entry.title} · ${entry.text}`;
}

/**
 * The table of contents: sealed sitting lines only, ordered by startAt. A
 * month with a month line replaces all of that month's sitting lines with
 * one entry; the month entry's startAt is the earliest line it replaces so
 * ordering against other months stays stable.
 */
export function tocSnapshot(
	lines: readonly LineRow[],
	months: readonly MonthLineRow[],
	sittings: readonly SittingRow[],
): TocEntry[] {
	const titles = new Map<string, { title: string | null; startAt: number }>();
	for (const sitting of sittings) {
		titles.set(`${sitting.conversationId}:${sitting.startEntryId}`, {
			title: sitting.title,
			startAt: sitting.startAt,
		});
	}
	const monthRows = new Map<string, MonthLineRow>();
	for (const row of months) {
		monthRows.set(`${row.conversationId}:${row.month}`, row);
	}
	const replaced = new Map<string, TocEntry>();
	const entries: TocEntry[] = [];
	for (const line of lines) {
		if (!line.sealed) continue;
		const sitting = titles.get(`${line.conversationId}:${line.startEntryId}`);
		const startAt = sitting?.startAt ?? 0;
		const monthRow = monthRows.get(`${line.conversationId}:${monthOf(startAt)}`);
		if (monthRow !== undefined) {
			const replaceKey = `${monthRow.conversationId}:${monthRow.month}`;
			const existing = replaced.get(replaceKey);
			if (existing === undefined || startAt < existing.startAt) {
				replaced.set(replaceKey, {
					startAt,
					title: null,
					text: monthRow.text,
					cls: monthRow.cls,
					month: monthRow.month,
				});
			}
			continue;
		}
		entries.push({
			startAt,
			title: sitting?.title ?? null,
			text: line.text,
			cls: line.cls,
		});
	}
	return [...entries, ...replaced.values()].sort(
		(left, right) => left.startAt - right.startAt,
	);
}

/**
 * Render the table for one model. Entries the model may not read are
 * dropped; when the joined lines exceed the byte budget the oldest entries
 * are dropped and a note (counted inside the budget) points at search.
 */
export function renderToc(
	toc: readonly TocEntry[],
	model: { provider: string; id: string } | undefined,
	isLocal: (model: string) => boolean,
): string {
	const readable = toc.filter((entry) => mayRead(entry.cls, model, isLocal));
	const lines = readable.map(formatEntry);
	let joined = lines.join("\n");
	if (Buffer.byteLength(joined) <= TOC_BUDGET_BYTES) return joined;
	const noteBytes = Buffer.byteLength(OLDER_NOTE) + 1;
	const kept: string[] = [];
	let bytes = noteBytes;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index]!;
		const lineBytes = Buffer.byteLength(line) + (kept.length > 0 ? 1 : 0);
		if (bytes + lineBytes > TOC_BUDGET_BYTES) break;
		kept.unshift(line);
		bytes += lineBytes;
	}
	joined = `${OLDER_NOTE}\n${kept.join("\n")}`;
	return joined;
}

/** The untruncated byte size of every entry, as renderToc would format them. */
export function tocBytes(toc: readonly TocEntry[]): number {
	return Buffer.byteLength(toc.map(formatEntry).join("\n"));
}

/** The last-resort sitting line: the first user message, trimmed to 120 chars. */
export function fallbackLine(boundaryText: string): string {
	const collapsed = boundaryText.replace(/\s+/g, " ").trim();
	if (collapsed.length <= 120) return collapsed;
	const cut = collapsed.slice(0, 120);
	const lastSpace = cut.lastIndexOf(" ");
	return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/** What createBoundary seals: the covering draft, else the fallback. */
export function sealArgs(
	open: SittingRow,
	line: LineRow | undefined,
	latestEntryId: number,
	cls: Confidentiality,
): {
	startEntryId: number;
	line: { text: string; cls: Confidentiality; coversThrough: number };
} {
	if (line !== undefined && line.coversThrough >= latestEntryId) {
		return {
			startEntryId: open.startEntryId,
			line: { text: line.text, cls: line.cls, coversThrough: line.coversThrough },
		};
	}
	return {
		startEntryId: open.startEntryId,
		line: {
			text: fallbackLine(open.boundaryText),
			cls,
			coversThrough: latestEntryId,
		},
	};
}
