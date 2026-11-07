/** Harness-written result codes: the call never ran. */
export const HARNESS_RESULT_CODES = [
    "tool_unavailable",
    "invalid_arguments",
    "blocked",
    "interrupted",
    "restart_limit",
    "aborted",
    "abandoned",
];
/** False when the harness wrote `result` for a call that never executed. */
export function toolExecuted(result) {
    const codes = HARNESS_RESULT_CODES;
    return !(result.diagnostics ?? []).some((d) => d.code !== undefined && codes.includes(d.code));
}
