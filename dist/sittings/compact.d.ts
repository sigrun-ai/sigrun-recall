import type { EntryRecord } from "@earendil-works/pi-durable";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import type { RecallDb } from "../db.js";
import { type EntriesReader } from "./lineage.js";
export declare const OVERFLOW_SUMMARY = "Earlier sittings of this conversation are listed in the table of contents and reachable through recall.";
export declare const SUMMARY_PROMPT = "Summarize this part of the conversation so the assistant can continue it: decisions, open questions, names, numbers and anything the user asked to remember. Reply with the summary only.";
export interface CompactDeps {
    conversationId: number;
    db: RecallDb;
    read: EntriesReader;
    complete: SigrunHost["models"]["complete"];
}
/**
 * Compaction never re-summarizes earlier sittings (spec §6.5): their
 * material lives in the table of contents and recall, not in a model
 * summary. Classification goes by the range's real start — the entries
 * list carries the previous head marker FIRST, and a `pi.compaction`
 * marker has a high id but a `head` pointing backward.
 */
export declare function beforeCompactSittings(compaction: {
    reason: "manual" | "threshold" | "overflow";
    entries: readonly EntryRecord[];
    firstKept: number;
}, deps: CompactDeps): Promise<{
    decline: true;
} | {
    summary: string;
} | undefined>;
