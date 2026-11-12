import type {
	ConversationId,
	Cursor,
	EntryId,
	EntryRecord,
	Page,
} from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionWorker, SigrunHost } from "@sigrun/sigrun/extension";

import type { Confidentiality, RecallDb } from "../db.js";
import { fallbackLine, TOC_BUDGET_BYTES, tocBytes, tocSnapshot } from "./toc.js";
import type { LineRow, SittingRow } from "./types.js";

export const LINE_PROMPT =
	"Summarize this part of a conversation in one line of at most 20 words: what was asked and what was concluded. Reply with the line only.";
export const MONTH_PROMPT =
	"Merge these one-line summaries into one line of at most 30 words. Reply with the line only.";

const PAGE_SIZE = 200;
const PROMPT_CHAR_BUDGET = 6000;
const COMPLETE_TIMEOUT_MS = 60_000;
const MAX_COLLAPSES = 100;
const MAX_FIRST_USER_PAGES = 20;

export interface DrafterDeps {
	db: () => RecallDb;
	host: Pick<SigrunHost, "conversations" | "models">;
	userEnabled(user: string): Promise<boolean>;
	now(): number;
}

export function messageText(message: Message | undefined): string {
	if (message === undefined) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n");
}

function isUserInput(entry: EntryRecord): boolean {
	return entry.kind === "pi.user" || entry.kind === "sigrun.user.expanded";
}

function isAssistant(entry: EntryRecord): boolean {
	return entry.kind === "pi.assistant";
}

/** The sitting's user/assistant texts, capped at the prompt budget. */
function sittingPrompt(
	entries: readonly EntryRecord[],
	startEntryId: number,
): string {
	let prompt = "";
	for (const entry of entries) {
		if (entry.id < startEntryId) continue;
		if (!isUserInput(entry) && !isAssistant(entry)) continue;
		const text = messageText(entry.model?.[0]);
		if (text.length === 0) continue;
		const role = isUserInput(entry) ? "User" : "Assistant";
		const piece = `${role}: ${text}\n`;
		if (prompt.length + piece.length > PROMPT_CHAR_BUDGET) {
			prompt += piece.slice(0, Math.max(0, PROMPT_CHAR_BUDGET - prompt.length));
			break;
		}
		prompt += piece;
	}
	return prompt;
}

async function readPage(
	host: Pick<SigrunHost, "conversations">,
	conversationId: number,
	query: { minEntryId?: number; order: "ascending" | "descending" },
	limit: number,
	cursor?: Cursor,
): Promise<Page<EntryRecord, Cursor>> {
	return host.conversations.entries(
		conversationId as ConversationId,
		{ ...query, minEntryId: query.minEntryId as EntryId | undefined },
		limit,
		cursor,
	);
}

async function readEntries(
	host: Pick<SigrunHost, "conversations">,
	conversationId: number,
	query: { minEntryId?: number; order: "ascending" | "descending" },
	limit: number,
): Promise<EntryRecord[]> {
	const page = await readPage(host, conversationId, query, limit);
	return [...page.items];
}

async function readFirstUser(
	host: Pick<SigrunHost, "conversations">,
	conversationId: number,
): Promise<EntryRecord | undefined> {
	let cursor: Cursor | undefined;
	for (let pageNumber = 0; pageNumber < MAX_FIRST_USER_PAGES; pageNumber += 1) {
		const page = await readPage(
			host,
			conversationId,
			{ order: "ascending" },
			PAGE_SIZE,
			cursor,
		);
		const firstUser = page.items.find(
			(entry) => entry.conversationId === conversationId && isUserInput(entry),
		);
		if (firstUser !== undefined) return firstUser;
		if (page.next === undefined) return undefined;
		cursor = page.next;
	}
	return undefined;
}

export function firstSitting(conversationId: number, entry: EntryRecord): SittingRow {
	return {
		conversationId,
		startEntryId: entry.id,
		startAt: entry.model?.[0]?.timestamp ?? 0,
		boundary: false,
		boundaryText: messageText(entry.model?.[0]),
		previous: null,
		block: null,
		title: null,
		titleState: "none",
	};
}

/** Read only the entries the bounded drafting prompt can actually use. */
async function readDraftEntries(
	host: Pick<SigrunHost, "conversations">,
	conversationId: number,
	startEntryId: number,
): Promise<EntryRecord[]> {
	const all: EntryRecord[] = [];
	let promptBytes = 0;
	let cursor: Cursor | undefined;
	do {
		const page = await readPage(
			host,
			conversationId,
			{ order: "ascending", minEntryId: startEntryId },
			PAGE_SIZE,
			cursor,
		);
		for (const entry of page.items) {
			all.push(entry);
			if (!isUserInput(entry) && !isAssistant(entry)) continue;
			const text = messageText(entry.model?.[0]);
			if (text.length === 0) continue;
			const role = isUserInput(entry) ? "User" : "Assistant";
			promptBytes += Buffer.byteLength(`${role}: ${text}\n`);
			if (promptBytes > PROMPT_CHAR_BUDGET) return all;
		}
		cursor = page.next;
	} while (cursor !== undefined);
	return all;
}

export function createSittingDrafter(deps: DrafterDeps): ExtensionWorker {
	return {
		name: "sittings",
		wakeOn: ["conversationIdle"],
		run: async (_context, wake) => {
			if (wake === undefined || wake.event !== "conversationIdle") return;
			const conversationId = Number(wake.conversationId);
			const meta = await deps.host.conversations.meta(wake.conversationId);
			if (meta.internal === true || meta.source === "cron" || meta.jobId !== undefined) {
				return;
			}
			if (meta.owner !== undefined && !(await deps.userEnabled(meta.owner))) {
				return;
			}
			const [latest] = await readEntries(
				deps.host,
				conversationId,
				{ order: "descending" },
				1,
			);
			if (latest === undefined) return;
			const latestEntryId = latest.id;
			const db = deps.db();
			if (db.sittings([conversationId]).length === 0) {
				const firstUser = await readFirstUser(deps.host, conversationId);
				if (firstUser === undefined) return;
				db.putSitting(firstSitting(conversationId, firstUser));
			}

			const sittings = db.sittings([conversationId]);
			const newest = sittings.at(-1);
			if (newest !== undefined) {
				const lines = db.lines([conversationId]);
				const line = lines.find(
					(candidate) => candidate.startEntryId === newest.startEntryId,
				);
				if (
					(line === undefined || !line.sealed) &&
					(line?.coversThrough ?? 0) < latestEntryId
				) {
					const entries = await readDraftEntries(
						deps.host,
						conversationId,
						newest.startEntryId,
					);
					await draftLine(
						db,
						deps,
						newest,
						entries,
						entries.at(-1)?.id ?? latestEntryId,
					);
				}
			}
			await collapseMonths(db, deps, conversationId);
		},
	};
}

async function draftLine(
	db: RecallDb,
	deps: DrafterDeps,
	open: SittingRow,
	entries: readonly EntryRecord[],
	latestEntryId: number,
): Promise<void> {
	const taintFrom = db.taintFrom(open.conversationId);
	const cls: Confidentiality =
		taintFrom !== undefined && taintFrom <= latestEntryId
			? "local-only"
			: "normal";
	let text: string;
	if (cls === "local-only") {
		text = fallbackLine(open.boundaryText);
	} else {
		try {
			const completion = await deps.host.models.complete({
				role: "utility",
				systemPrompt: LINE_PROMPT,
				prompt: sittingPrompt(entries, open.startEntryId),
				timeoutMs: COMPLETE_TIMEOUT_MS,
			});
			text = completion.text.trim();
			if (text.length === 0) text = fallbackLine(open.boundaryText);
		} catch {
			text = fallbackLine(open.boundaryText);
		}
	}
	db.putLineDraft({
		conversationId: open.conversationId,
		startEntryId: open.startEntryId,
		text,
		cls,
		coversThrough: latestEntryId,
	});
}

/**
 * Collapse the oldest complete months until the table fits its budget.
 * A month line is written once and never rewritten, so repeated wakes make
 * progress strictly month by month; the attempt cap guards the loop when
 * even a fully collapsed table exceeds the budget.
 */
async function collapseMonths(
	db: RecallDb,
	deps: DrafterDeps,
	conversationId: number,
): Promise<void> {
	const currentMonth = new Date(deps.now()).toISOString().slice(0, 7);
	for (let attempt = 0; attempt < MAX_COLLAPSES; attempt += 1) {
		const sittings = db.sittings([conversationId]);
		const lines = db.lines([conversationId]);
		const months = db.monthLines([conversationId]);
		const toc = tocSnapshot(lines, months, sittings);
		const previousBytes = tocBytes(toc);
		if (previousBytes <= TOC_BUDGET_BYTES) return;
		const collapsed = new Set(months.map((row) => row.month));
		const byMonth = new Map<string, { line: LineRow; sitting: SittingRow }[]>();
		for (const line of lines) {
			if (!line.sealed) continue;
			const sitting = sittings.find(
				(candidate) => candidate.startEntryId === line.startEntryId,
			);
			if (sitting === undefined) continue;
			const month = new Date(sitting.startAt).toISOString().slice(0, 7);
			if (month >= currentMonth || collapsed.has(month)) continue;
			const group = byMonth.get(month) ?? [];
			group.push({ line, sitting });
			byMonth.set(month, group);
		}
		const candidate = [...byMonth.entries()]
			.filter(([, group]) => group.length >= 2)
			.sort(([left], [right]) => left.localeCompare(right))[0];
		if (candidate === undefined) return;
		const [month, group] = candidate;
		const anyLocal = group.some(({ line }) => line.cls === "local-only");
		if (anyLocal) {
			db.putMonthLine({
				conversationId,
				month,
				cls: "local-only",
				text: group
					.map(({ sitting }) => sitting.title ?? fallbackLine(sitting.boundaryText))
					.join("; "),
			});
			if (currentBytes(db, conversationId) >= previousBytes) return;
			continue;
		}
		let text: string;
		try {
			const completion = await deps.host.models.complete({
				role: "utility",
				systemPrompt: MONTH_PROMPT,
				prompt: group.map(({ line }) => line.text).join("\n"),
				timeoutMs: COMPLETE_TIMEOUT_MS,
			});
			text = completion.text.trim();
			if (text.length === 0) {
				text = group.map(({ line }) => line.text).join("; ");
			}
		} catch {
			// A month line is irreversible: leave it unwritten and retry on
			// the next wake instead of persisting an unreviewed join.
			return;
		}
		db.putMonthLine({ conversationId, month, cls: "normal", text });
		if (currentBytes(db, conversationId) >= previousBytes) return;
	}
}

function currentBytes(db: RecallDb, conversationId: number): number {
	return tocBytes(
		tocSnapshot(
			db.lines([conversationId]),
			db.monthLines([conversationId]),
			db.sittings([conversationId]),
		),
	);
}
