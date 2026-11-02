import { defineTask } from "@earendil-works/pi-durable";
export const BACKFILL_TASK_NAME = "recall.backfill";
/** Sweep conversations in rotating id order under a bounded entry/time budget. */
export async function runSweep(deps) {
    const started = (deps.now ?? Date.now)();
    const [archived, active] = await Promise.all([
        deps.host.conversations.list({ archived: true }),
        deps.host.conversations.list({ archived: false }),
    ]);
    const ids = [...archived, ...active].map(({ id }) => Number(id)).sort((a, b) => a - b);
    let sweepAfter = Number(deps.db.state("sweepAfter") ?? 0);
    const start = ids.findIndex((id) => id > sweepAfter);
    const ordered = start < 0 ? ids : [...ids.slice(start), ...ids.slice(0, start)];
    let indexed = 0;
    let entries = 0;
    const entryBudget = deps.entryBudget ?? 2000;
    for (const id of ordered) {
        if ((deps.now ?? Date.now)() - started >= 20_000 || entries >= entryBudget)
            break;
        try {
            const result = await deps.capture({
                db: deps.db,
                meta: (conversationId) => deps.host.conversations.meta(conversationId),
                now: deps.now ?? Date.now,
            }, id, async (query, limit, cursor) => {
                const page = await deps.host.conversations.entries(id, query, limit, cursor);
                entries += page.items.length;
                return page;
            });
            indexed += result.indexed;
            sweepAfter = id;
            deps.db.setState("sweepAfter", String(id));
        }
        catch (error) {
            console.error(`recall: backfill failed for conversation ${id}`, error);
        }
    }
    await deps.vectors?.();
    return { indexed, sweepAfter };
}
/** Register the one-phase cron backfill task. */
export function createBackfillTask(deps) {
    const resolve = typeof deps === "function" ? deps : () => deps;
    return defineTask({
        name: BACKFILL_TASK_NAME,
        version: 1,
        initial: () => ({ phase: "sweep" }),
        phases: {
            sweep: async (_task, runtime, context) => {
                const result = await runSweep(resolve());
                await runtime.commit(() => ({
                    status: "terminal",
                    outcome: { status: "completed", result },
                }), context);
            },
        },
        abort: async (_task, runtime, context) => {
            await runtime.commit(() => ({
                status: "terminal",
                outcome: { status: "failed", error: { message: "aborted" } },
            }), context);
        },
    });
}
