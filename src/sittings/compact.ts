import type { EntryRecord } from "@earendil-works/pi-durable";
import type { SigrunHost } from "@sigrun/sigrun/extension";

import type { RecallDb } from "../db.js";
import { messageText } from "./drafter.js";
import { loadLineage, type EntriesReader, type LineageLink } from "./lineage.js";
import { currentBoundary } from "./request.js";

export const OVERFLOW_SUMMARY =
	"Earlier sittings of this conversation are listed in the table of contents and reachable through recall.";

export const SUMMARY_PROMPT =
	"Summarize this part of the conversation so the assistant can continue it: decisions, open questions, names, numbers and anything the user asked to remember. Reply with the summary only.";

const PROMPT_CHAR_BUDGET = 24_000;
const COMPLETE_TIMEOUT_MS = 120_000;
const COMPACTION_KIND = "pi.compaction";

export interface CompactDeps {
	conversationId: number;
	db: RecallDb;
	read: EntriesReader;
	complete: SigrunHost["models"]["complete"];
}

/** A `pi.compaction` marker's backward-pointing TOP-LEVEL head. */
function markerHead(entry: EntryRecord): number | undefined {
	if (entry.kind !== COMPACTION_KIND) return undefined;
	return typeof entry.head === "number" ? entry.head : undefined;
}

/**
 * The in-sitting entries the summarizer may read: non-marker entries with
 * `id ≥ startEntryId` plus markers whose HEAD is inside the sitting (an
 * earlier in-sitting summary). Material from an earlier sitting is never
 * fed to the summarizer.
 */
function inSittingPrompt(entries: readonly EntryRecord[], startEntryId: number): string {
	let prompt = "";
	for (const entry of entries) {
		if (entry.kind === COMPACTION_KIND) {
			const head = markerHead(entry);
			if (head === undefined || head < startEntryId) continue;
		} else if (entry.id < startEntryId) {
			continue;
		}
		const text = (entry.model ?? []).map((message) => messageText(message)).join("\n");
		if (text.length === 0) continue;
		const piece = `${text}\n`;
		if (prompt.length + piece.length > PROMPT_CHAR_BUDGET) break;
		prompt += piece;
	}
	return prompt;
}

/**
 * Compaction never re-summarizes earlier sittings (spec §6.5): their
 * material lives in the table of contents and recall, not in a model
 * summary. Classification goes by the range's real start — the entries
 * list carries the previous head marker FIRST, and a `pi.compaction`
 * marker has a high id but a `head` pointing backward.
 */
export async function beforeCompactSittings(
	compaction: {
		reason: "manual" | "threshold" | "overflow";
		entries: readonly EntryRecord[];
		firstKept: number;
	},
	deps: CompactDeps,
): Promise<{ decline: true } | { summary: string } | undefined> {
	const ownLineage = (): LineageLink[] => [{
		conversationId: deps.conversationId,
		throughEntryId: Number.POSITIVE_INFINITY,
		throughAt: Number.POSITIVE_INFINITY,
	}];
	// FAIL-OPEN by design: if lineage cannot be read, the built-in
	// summarizer may still see an earlier sitting rather than failing the run.
	const lineage = await loadLineage(deps.conversationId, deps.read, { memo: new Map() })
		.catch(ownLineage);
	const boundary = currentBoundary(
		deps.db.sittings(lineage.map((link) => link.conversationId)),
		lineage,
	);
	if (boundary === undefined) return undefined;
	const startEntryId = boundary.startEntryId;

	// A declined overflow fails the run and a declined manual is a silent
	// no-op, so only threshold may decline; the others get the fixed text.
	const beforeBoundary = (): { decline: true } | { summary: string } =>
		compaction.reason === "threshold"
			? { decline: true }
			: { summary: OVERFLOW_SUMMARY };

	if (compaction.firstKept <= startEntryId) return beforeBoundary();

	let rangeStart = Number.POSITIVE_INFINITY;
	let preBoundaryMarker = false;
	for (const entry of compaction.entries) {
		if (entry.kind === COMPACTION_KIND) {
			const head = markerHead(entry);
			if (head !== undefined && head < startEntryId) preBoundaryMarker = true;
		} else {
			rangeStart = Math.min(rangeStart, entry.id);
		}
	}
	if (rangeStart >= startEntryId && !preBoundaryMarker) {
		// Entirely after the boundary: the built-in compaction is confined
		// to the sitting and runs untouched.
		return undefined;
	}

	const prompt = inSittingPrompt(compaction.entries, startEntryId);
	try {
		const result = await deps.complete({
			role: "utility",
			systemPrompt: SUMMARY_PROMPT,
			prompt,
			timeoutMs: COMPLETE_TIMEOUT_MS,
		});
		if (result.text.trim() === "") return beforeBoundary();
		return { summary: result.text };
	} catch {
		return beforeBoundary();
	}
}
