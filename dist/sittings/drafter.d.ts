import type { ExtensionWorker, SigrunHost } from "@sigrun/sigrun/extension";
import type { RecallDb } from "../db.js";
export declare const LINE_PROMPT = "Summarize this part of a conversation in one line of at most 20 words: what was asked and what was concluded. Reply with the line only.";
export declare const MONTH_PROMPT = "Merge these one-line summaries into one line of at most 30 words. Reply with the line only.";
export interface DrafterDeps {
    db: () => RecallDb;
    host: Pick<SigrunHost, "conversations" | "models">;
    userEnabled(user: string): Promise<boolean>;
    now(): number;
}
export declare function createSittingDrafter(deps: DrafterDeps): ExtensionWorker;
