import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { RunSettledEvent, SigrunHost } from "@sigrun/sigrun/extension";

import type { RecallDb } from "../db.js";
import { messageText } from "./drafter.js";
import type { SittingRow } from "./types.js";

/** Core's NAMING_SYSTEM_PROMPT, kept verbatim (core src/harness/naming.ts). */
export const TITLE_PROMPT =
	"Write a short title (at most 6 words) for this conversation. Reply with the title only: no quotes, no trailing punctuation.";

const TITLE_CHAR_LIMIT = 60;
const TITLE_WORD_LIMIT = 6;
const PROMPT_TEXT_LIMIT = 2_000;
const TITLE_TIMEOUT_MS = 20_000;

/**
 * Copy of core src/harness/naming.ts:75-93 (not exported to extensions).
 * Keep in sync: trim, matching quote pairs, `Title:`, whitespace, trailing
 * sentence punctuation, six words, then 60 characters on a word boundary.
 */
export function cleanTitle(raw: string): string | undefined {
	// Dividers render this label raw: remove C0/C1 controls before any caps.
	let text = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "").trim();
	for (;;) {
		const quoted = /^(['"`])([\s\S]*)\1$/.exec(text);
		if (quoted === null) break;
		text = quoted[2]!.trim();
	}
	text = text.replace(/^title:\s*/i, "");
	text = text.replace(/\s+/g, " ").trim();
	text = text.replace(/[.,;:!?]+$/, "").trim();
	if (text === "") return undefined;
	text = text.split(" ").slice(0, TITLE_WORD_LIMIT).join(" ");
	if (text.length > TITLE_CHAR_LIMIT) {
		const slice = text.slice(0, TITLE_CHAR_LIMIT);
		const boundary = slice.lastIndexOf(" ");
		text = boundary > 0 ? slice.slice(0, boundary) : slice;
	}
	return text === "" ? undefined : text;
}

export interface SittingTitlerDeps {
	db: () => RecallDb;
	host: Pick<SigrunHost, "conversations" | "models">;
	log(message: string): void;
}

export interface SittingTitler {
	onSettled(event: RunSettledEvent): void;
	idle(): Promise<void>;
	/** Stop host/DB effects, wait for the current call up to `timeoutMs`. */
	shutdown(timeoutMs?: number): Promise<void>;
}

/** Title pending sittings in the background, one settled event at a time. */
export function createSittingTitler(deps: SittingTitlerDeps): SittingTitler {
	let tail: Promise<void> = Promise.resolve();
	let stopped = false;
	return {
		onSettled(event) {
			tail = tail
				.then(() => titleSittings(event))
				.catch((error: unknown) => {
					deps.log(`recall: sitting titling failed — ${errorText(error)}`);
				});
		},
		idle: () => tail,
		async shutdown(timeoutMs = 20_000) {
			stopped = true;
			let timer: ReturnType<typeof setTimeout>;
			await Promise.race([
				tail,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, timeoutMs);
					timer.unref?.();
				}),
			]).finally(() => clearTimeout(timer));
		},
	};

	async function titleSittings(event: RunSettledEvent): Promise<void> {
		if (stopped || event.outcome?.status !== "answered" || event.replayed === true) return;
		const id = event.conversationId;
		const answerEntryId = Number(event.outcome.answerEntryId);
		const taintFrom = deps.db().taintFrom(Number(id));
		const pending = deps.db().sittings([Number(id)]).filter(
			(row) => row.titleState === "pending" && row.startEntryId < answerEntryId,
		);
		const localOnly = taintFrom !== undefined && taintFrom <= answerEntryId;
		for (const row of pending) {
			if (stopped) return;
			await titleSitting(row, event.outcome.answer, localOnly, id);
		}
	}

	async function titleSitting(
		row: SittingRow,
		answer: AssistantMessage,
		localOnly: boolean,
		id: ConversationId,
	): Promise<void> {
		try {
			const title = localOnly
				? cleanTitle(row.boundaryText)
				: cleanTitle(await completion(row, answer));
			if (title === undefined) throw new Error("no usable title");
			if (stopped) return;
			if (typeof deps.host.conversations.setAutoName === "function") {
				await deps.host.conversations.setAutoName(id, title);
			}
			await mark(id, row.startEntryId, `New sitting · ${title}`);
			deps.db().setSittingTitle(row.conversationId, row.startEntryId, title, "done");
		} catch (error) {
			if (stopped) return;
			try {
				await mark(id, row.startEntryId, "New sitting");
				deps.db().setSittingTitle(row.conversationId, row.startEntryId, null, "failed");
			} catch (failureError) {
				deps.log(
					`recall: could not record the sitting title failure: ${errorText(failureError)}`,
				);
				return;
			}
			deps.log(`recall: sitting title failed — ${errorText(error)}`);
		}
	}

	async function completion(row: SittingRow, answer: AssistantMessage): Promise<string> {
		const result = await deps.host.models.complete({
			role: "utility",
			systemPrompt: TITLE_PROMPT,
			prompt:
				`User: ${row.boundaryText.slice(0, PROMPT_TEXT_LIMIT)}\n\n` +
				`Assistant: ${messageText(answer).slice(0, PROMPT_TEXT_LIMIT)}`,
			timeoutMs: TITLE_TIMEOUT_MS,
		});
		return result.text;
	}

	async function mark(id: ConversationId, at: number, label: string): Promise<void> {
		if (typeof deps.host.conversations.markContext !== "function") return;
		await deps.host.conversations.markContext(id, { at: at as EntryId, label });
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
