import type {
	ConversationId,
	Cursor,
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

export interface DrafterDeps {
	db: () => RecallDb;
	host: Pick<SigrunHost, "conversations" | "models">;
	userEnabled(user: string): Promise<boolean>;
	now(): number;
}

function messageText(message: Message | undefined): string {
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

async function readAllEntries(
	host: Pick<SigrunHost, "conversations">,
	conversationId: number,
): Promise<EntryRecord[]> {
	const all: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page: Page<EntryRecord, Cursor> = await host.conversations.entries(
			conversationId as ConversationId,
			{ order: "ascending" },
			PAGE_SIZE,
			cursor,
		);
		all.push(...page.items);
		cursor = page.next;
	} while (cursor !== undefined);
	return all;
}

function firstSitting(conversationId: number, entry: EntryRecord): SittingRow {
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
			const entries = await readAllEntries(deps.host, conversationId);
			const own = entries.filter((entry) => entry.conversationId === conversationId);
			const firstUser = own.find(isUserInput);
			if (firstUser === undefined) return;
			const db = deps.db();
			const latestEntryId = own.at(-1)?.id ?? firstUser.id;

			db.putSitting(firstSitting(conversationId, firstUser));

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
					await draftLine(db, deps, newest, line, entries, latestEntryId);
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
	line: LineRow | undefined,
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
		if (tocBytes(toc) <= TOC_BUDGET_BYTES) return;
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
			text = group.map(({ line }) => line.text).join("; ");
		}
		db.putMonthLine({ conversationId, month, cls: "normal", text });
	}
}
