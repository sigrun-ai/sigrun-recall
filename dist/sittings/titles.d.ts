import type { RunSettledEvent, SigrunHost } from "@sigrun/sigrun/extension";
import type { RecallDb } from "../db.js";
/** Core's NAMING_SYSTEM_PROMPT, kept verbatim (core src/harness/naming.ts). */
export declare const TITLE_PROMPT = "Write a short title (at most 6 words) for this conversation. Reply with the title only: no quotes, no trailing punctuation.";
/**
 * Copy of core src/harness/naming.ts:75-93 (not exported to extensions).
 * Keep in sync: trim, matching quote pairs, `Title:`, whitespace, trailing
 * sentence punctuation, six words, then 60 characters on a word boundary.
 */
export declare function cleanTitle(raw: string): string | undefined;
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
export declare function createSittingTitler(deps: SittingTitlerDeps): SittingTitler;
