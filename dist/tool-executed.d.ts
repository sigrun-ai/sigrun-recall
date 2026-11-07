/**
 * The pi-durable 1.5.0 afterTool gating (spec §3.2-b): the harness runs
 * `afterTool` on results IT wrote for calls that never executed —
 * blocked, invalid_arguments, tool_unavailable, interrupted,
 * restart_limit, aborted, abandoned. `call.arguments` on those results
 * may be raw unvalidated model text. An extension's afterTool must
 * early-return unless the call actually executed.
 *
 * Copied per repo — extensions never runtime-import core internals.
 */
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
/** Harness-written result codes: the call never ran. */
export declare const HARNESS_RESULT_CODES: readonly ["tool_unavailable", "invalid_arguments", "blocked", "interrupted", "restart_limit", "aborted", "abandoned"];
/** False when the harness wrote `result` for a call that never executed. */
export declare function toolExecuted(result: ToolExecutionResult): boolean;
