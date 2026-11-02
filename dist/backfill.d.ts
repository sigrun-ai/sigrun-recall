import { type AnyTask } from "@earendil-works/pi-durable";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import type { captureConversation } from "./capture.js";
import type { RecallDb } from "./db.js";
export declare const BACKFILL_TASK_NAME = "recall.backfill";
export interface BackfillDeps {
    host: SigrunHost;
    capture: typeof captureConversation;
    db: RecallDb;
    vectors?: () => Promise<void>;
    now?: () => number;
    entryBudget?: number;
}
/** Sweep conversations in rotating id order under a bounded entry/time budget. */
export declare function runSweep(deps: BackfillDeps): Promise<{
    indexed: number;
    sweepAfter: number;
}>;
/** Register the one-phase cron backfill task. */
export declare function createBackfillTask(deps: BackfillDeps): AnyTask;
