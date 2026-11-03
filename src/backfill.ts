import type { ConversationId, EntryQuery } from "@earendil-works/pi-durable";
import { defineTask, type AnyTask } from "@earendil-works/pi-durable";
import type { SigrunHost } from "@sigrun/sigrun/extension";

import type { captureConversation } from "./capture.js";
import type { RecallDb } from "./db.js";

export const BACKFILL_TASK_NAME = "recall.backfill";

export interface BackfillDeps {
	host: SigrunHost;
	capture: typeof captureConversation;
	db: RecallDb;
	vectors?: () => Promise<void>;
	now?: () => number;
	entryBudget?: number;
}

/** Sweep conversations in rotating id order under a bounded entry/time budget. */
export async function runSweep(
	deps: BackfillDeps,
): Promise<{ indexed: number; sweepAfter: number }> {
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
		if ((deps.now ?? Date.now)() - started >= 20_000 || entries >= entryBudget) break;
		try {
			const result = await deps.capture(
				{
					db: deps.db,
					meta: (conversationId) => deps.host.conversations.meta(conversationId as ConversationId),
					now: deps.now ?? Date.now,
				},
				id,
				async (query, limit, cursor) => {
					const page = await deps.host.conversations.entries(
						id as ConversationId,
						query as Omit<EntryQuery, "conversationId">,
						limit,
						cursor,
					);
					entries += page.items.length;
					return page;
				},
			);
			indexed += result.indexed;
			sweepAfter = id;
			deps.db.setState("sweepAfter", String(id));
		} catch (error) {
			console.error(`recall: backfill failed for conversation ${id}`, error);
		}
	}
	await deps.vectors?.();
	return { indexed, sweepAfter };
}

/** Register the one-phase cron backfill task. */
export function createBackfillTask(deps: BackfillDeps | (() => BackfillDeps)): AnyTask {
	const resolve = typeof deps === "function" ? deps : () => deps;
	return defineTask({
		name: BACKFILL_TASK_NAME,
		version: 1,
		initial: (): { phase: "sweep" } => ({ phase: "sweep" }),
		phases: {
			sweep: async (_task, runtime, context) => {
				const result = await runSweep(resolve());
				await runtime.commit(
					() => ({
						status: "terminal" as const,
						outcome: { status: "completed" as const, result },
					}),
					context,
				);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(
				() => ({
					status: "terminal" as const,
					outcome: { status: "failed" as const, error: { message: "aborted" } },
				}),
				context,
			);
		},
	}) as AnyTask;
}
