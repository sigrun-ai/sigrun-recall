import { join } from "node:path";

import {
	AgentDoc,
	defineExtension,
	GenerationTask,
	hook,
	ToolTask,
	type ConversationId,
	type EntryId,
} from "@earendil-works/pi-durable";
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";

import { createArtifactStore, externalize } from "./artifacts.js";
import { BACKFILL_TASK_NAME, createBackfillTask, runSweep } from "./backfill.js";
import { captureConversation } from "./capture.js";
import { migrationLabel } from "./legacy-embedding.js";
import { RecallDb } from "./db.js";
import { createPublishedHooks } from "./hooks.js";
import { embeddingsMovedNotice, localProvidersMovedNotice, primaryAdmin } from "./notice.js";
import { createSearcher } from "./search.js";
import { toolExecuted } from "./tool-executed.js";
import { createRoutes } from "./route.js";
import {
	RECALL_SETTINGS_SCHEMA,
	RECALL_USER_SETTINGS_SCHEMA,
	type RecallSettings,
	type UserRecallSettings,
} from "./settings-schema.js";
import { createTools } from "./tools.js";
import { applyRecall } from "./inject.js";
import { loadLineage } from "./sittings/lineage.js";
import {
	createEmbeddingWarnings,
	createSqliteVectorIndex,
	createVectorArm,
	embedPending,
	type EmbeddingHost,
	type EmbeddingModelRow,
} from "./vectors.js";

/** Remove the retired per-user allowlist after telling its owner once. */
async function migrateLocalProviders(host: SigrunHost): Promise<void> {
	let users: readonly { user: string }[];
	try {
		users = await host.users.list();
	} catch (error) {
		console.warn("recall: the local-providers migration could not list users", error);
		return;
	}
	for (const { user } of users) {
		let store: ReturnType<SigrunHost["stores"]["user"]>["settings"];
		let raw: Record<string, unknown>;
		try {
			store = host.stores.user(user).settings;
			raw = await store.get();
		} catch (error) {
			console.warn(`recall: could not read local providers for "${user}"`, error);
			continue;
		}
		if (
			raw.localProviders === undefined ||
			raw.localProviders === null ||
			raw.localProviders === "" ||
			raw.localProviders === false ||
			(Array.isArray(raw.localProviders) && raw.localProviders.length === 0)
		) {
			continue;
		}
		try {
			await host.notify({ user, ...localProvidersMovedNotice() });
		} catch (error) {
			// A failed delivery must not remove the evidence: retry next boot.
			console.warn(`recall: the local-providers notice failed for "${user}"`, error);
			continue;
		}
		try {
			const { localProviders: _removed, ...remaining } = raw;
			await store.set(remaining);
		} catch (error) {
			// The notice was delivered but the removal failed. The next boot
			// may repeat that notice, but never silently drops the record.
			console.warn(`recall: could not remove local providers for "${user}"`, error);
		}
	}
}

export {
	RecallIndexInput,
	RecallIndexOutput,
	RecallRemoveInput,
	RecallRemoveOutput,
	RecallSearchInput,
	RecallSearchOutput,
} from "./hooks.js";

/** The query path's own budget: one short call, or the lexical results. */
const QUERY_TIMEOUT_MS = 800;

export interface FactoryDeps {
	openDb?: (path: string, labelModel?: string) => RecallDb;
	now?: () => number;
}

/**
 * The loader injects the host only when factory.length > 0: keep the host
 * bare and the optional test dependencies second, so the arity stays one.
 *
 * Async for the raw migration-label read only.
 */
export default async function createRecall(
	host: SigrunHost,
	deps: FactoryDeps = {},
): Promise<SigrunExtensionResult> {
	// Declare first: core requires the declaration during the factory call,
	// and the values are read on USE (never here). A factory-time read would
	// resolve the loader's provisional, specifier-derived slug rather than the
	// file the settings page writes.
	const settings = host.settings.declare<RecallSettings, UserRecallSettings>({
		schema: RECALL_SETTINGS_SCHEMA,
		userSchema: RECALL_USER_SETTINGS_SCHEMA,
	});
	// Best effort, and deliberately RAW: the dead `embedding` group is not in
	// the schema, so the declared handle cannot report it. An unreadable
	// settings file only costs the label, so the inherited rows are
	// re-embedded instead of being trusted.
	let rawSettings: Record<string, unknown> | undefined;
	try {
		rawSettings = await host.stores.settings.get();
	} catch {
		rawSettings = undefined;
	}
	const labelModel = rawSettings === undefined ? undefined : migrationLabel(rawSettings);
	const isLocal = (model: string): boolean => host.models.isLocal(model);
	const modelRef = (
		model: { provider: string; modelId: string } | undefined,
	): { provider: string; id: string } | undefined =>
		model === undefined ? undefined : { provider: model.provider, id: model.modelId };
	let database: RecallDb | undefined;
	let services: {
		searcher: ReturnType<typeof createSearcher>;
		tools: ReturnType<typeof createTools>;
	} | undefined;
	const pending = new Set<Promise<void>>();
	/**
	 * Bumped whenever the SWEEP has changed what coverage looks like. The
	 * search-model decision derives from a bounded `modelCoverage` scan, so
	 * it is cached against this counter rather than re-scanned per query.
	 * Capture-time embedding does not bump it: capturing into the current
	 * model cannot make an INCOMPLETE model complete (it only adds items),
	 * and the sweep is what finishes a switch anyway.
	 */
	let vectorGeneration = 0;
	const searchModelCaches = new Map<
		string,
		{ signature: string; model: string }
	>();
	let noticeRaised = false;
	let noticeAttempting = false;
	let localProvidersSweepAttempting = false;
	let localProvidersSweepRaised = false;
	const warnEmbedding = createEmbeddingWarnings();

	const embeddings: EmbeddingHost | undefined = host.embeddings;
	const trackEmbedding = (work: Promise<void>) => {
		// OBSERVE the rejection at creation: a capture page that rejects (a
		// throwing host, a closed database during shutdown) must never sit in
		// `pending` as an unhandled rejection — Node would end the process.
		const tracked = work
			.catch((error: unknown) => {
				warnEmbedding(
					"failed",
					error instanceof Error ? error.message : "passage embedding failed",
				);
			})
			.finally(() => pending.delete(tracked));
		pending.add(tracked);
	};

	// Core does not create paths.data; RecallDb.open creates its parent.
	function db(): RecallDb {
		database ??= (deps.openDb ?? RecallDb.open)(
			join(host.stores.paths.data, "recall.db"),
			labelModel,
		);
		return database;
	}

	/**
	 * One per boot, best effort: the OLD `embedding` block is dead
	 * configuration from here on, and the operator has to move the model
	 * into `embeddingModel` and the credential into auth.json themselves.
	 *
	 * The factory body cannot AWAIT it: `host.users`/`host.notify` are
	 * bridged members and boot binds the bridge only after
	 * `loadExtensions` returns, so a factory-body await would deadlock on a
	 * bridge that cannot bind until the factory returns. It is fired from
	 * the factory (void) and again on every semantic touch; the
	 * `noticeRaised` flag is only set once a RECIPIENT (or the empty
	 * directory) was resolved, so a pre-bind attempt that cannot reach the
	 * directory leaves the door open for the first post-bind touch (the
	 * first capture or the ten-minute sweep, whichever comes first).
	 *
	 * Recipients, exactly as core's contract defines them: an EMPTY
	 * directory (single-operator mode) is userless and receives the notice
	 * with `user: undefined` — `notifyExtension` only demands a user when
	 * `users.isClaimed()`, i.e. when the directory is non-empty. A
	 * non-empty directory with nobody carrying the admin flag is the ONE
	 * case recall drops: `undefined` would be rejected there, and there is
	 * no admin the notice is for.
	 */
	function maybeNoteEmbeddingsMoved(): void {
		if (noticeRaised || noticeAttempting || rawSettings === undefined) return;
		const notice = embeddingsMovedNotice(rawSettings);
		if (notice === undefined) return;
		noticeAttempting = true;
		void (async () => {
			let users: readonly { user: string; admin: boolean }[];
			try {
				users = await host.users.list();
			} catch {
				// No bridge yet, or the directory is unavailable: try again on
				// the next semantic touch.
				noticeAttempting = false;
				return;
			}
			// Resolved: stop trying whatever the outcome.
			noticeRaised = true;
			noticeAttempting = false;
			const user = primaryAdmin(users);
			if (user === undefined && users.length > 0) {
				// Users exist but none is an admin: there is nobody this notice
				// is FOR, and core would reject a userless notice here.
				return;
			}
			try {
				await host.notify({ user, ...notice });
			} catch (error) {
				console.warn("recall: the embeddings-moved notice was not delivered", error);
			}
		})();
	}
	maybeNoteEmbeddingsMoved();

	function maybeMigrateLocalProviders(): void {
		if (localProvidersSweepRaised || localProvidersSweepAttempting) return;
		localProvidersSweepAttempting = true;
		void migrateLocalProviders(host)
			.then(() => {
				localProvidersSweepRaised = true;
			})
			.finally(() => {
				localProvidersSweepAttempting = false;
			});
	}
	maybeMigrateLocalProviders();

	interface SemanticDeps {
		readonly embeddings: EmbeddingHost;
		/** The live default: what the sweep re-embeds into. */
		readonly current: EmbeddingModelRow;
		/** What queries embed with: the newest model that covers everything. */
		readonly search: EmbeddingModelRow;
	}

	/**
	 * The two models recall distinguishes:
	 *
	 * - **current** — the row core's `embeddingModel` resolves to (`default:
	 *   true`). The sweep re-embeds into it while older rows stay put.
	 * - **search** — the newest model whose coverage is complete, else the
	 *   current one (the Global Constraints' search-model rule). "Newest" is
	 *   `list()` order: core's registry enumerates providers in load order
	 *   and each provider's models in declaration order, so the highest
	 *   index is the most recently registered model.
	 *
	 * The scan walks the whole list backwards and takes the first COMPLETE
	 * row, with no shortcut past the current row: during a switch the
	 * current model's index is still empty while an older, complete one
	 * answers, and that older row can sit at ANY index — including below the
	 * current one. The common switch proves it: `3-small` -> `3-large` are
	 * two models of ONE provider, declared small-then-large, so the current
	 * row (`3-large`) is listed LAST and complete-`3-small` is listed
	 * BEFORE it. A rule that stopped at the current row would hand queries
	 * an empty index for the whole re-embed.
	 *
	 * Every row is a candidate on its own coverage; the current default is
	 * only the fallback for when NO row covers everything.
	 */
	function pickSemantic(
		rows: readonly EmbeddingModelRow[],
		owner: string | null,
	): SemanticDeps | undefined {
		if (embeddings === undefined) return undefined;
		const current = rows.find((row) => row.default === true);
		if (current === undefined) return undefined;
		const signature = JSON.stringify([
			vectorGeneration,
			rows.map((row) => [row.model, row.local, row.default === true]),
		]);
		const cacheKey = owner ?? "";
		const cachedEntry = searchModelCaches.get(cacheKey);
		if (cachedEntry?.signature === signature) {
			// SAFETY: the cache signature covers every row's model, locality
			// and default flag, so a cached model is still present and still
			// describes the same coverage question for this owner.
			const cached = rows.find((row) => row.model === cachedEntry.model);
			if (cached !== undefined) {
				return { embeddings, current, search: cached };
			}
		}
		// The rule, literally: the highest-index row whose coverage is
		// complete, else the current default. Coverage is per-row and asked
		// of EVERY row — never skipped for the current one.
		let search = current;
		for (let index = rows.length - 1; index >= 0; index -= 1) {
			const row = rows[index]!;
			if (db().modelCoverage(row.model, row.local, owner).complete) {
				search = row;
				break;
			}
		}
		searchModelCaches.set(cacheKey, { signature, model: search.model });
		return { embeddings, current, search };
	}

	async function semantic(user?: string): Promise<SemanticDeps | undefined> {
		maybeMigrateLocalProviders();
		if (embeddings === undefined) return undefined;
		maybeNoteEmbeddingsMoved();
		try {
			return pickSemantic(
				await embeddings.list(user === undefined ? undefined : { user }),
				user ?? null,
			);
		} catch (error) {
			// The registry can transiently fail to answer; degrade to lexical
			// and let the next call retry instead of caching the failure.
			console.error("recall: the embedding model list failed", error);
			return undefined;
		}
	}

	async function vectors(user?: string) {
		const semanticDeps = await semantic(user);
		if (semanticDeps === undefined) return undefined;
		return createVectorArm(
			semanticDeps.embeddings,
			createSqliteVectorIndex(db(), semanticDeps.search.model, user ?? null),
			semanticDeps.search.model,
			QUERY_TIMEOUT_MS,
			warnEmbedding,
			user,
		);
	}

	let artifacts: ReturnType<typeof createArtifactStore> | undefined;
	const artifactStore = () =>
		(artifacts ??= createArtifactStore(db(), join(host.stores.paths.data, "artifacts")));
	const meta = (id: number) => host.conversations.meta(id as ConversationId);
	const entry = (conversationId: number, entryId: number) =>
		host.conversations.entry(conversationId as ConversationId, entryId as EntryId);
	const DEFAULT_USER_SETTINGS: UserRecallSettings = { autoRecall: true, sittings: true };
	/**
	 * The per-user settings, defaulted and repaired by the declared handle.
	 * A read failure keeps the directory user's defaults instead of losing
	 * recall: settings are an optimisation here, never a gate.
	 */
	const userSettings = async (user: string): Promise<UserRecallSettings> => {
		try {
			return await settings.user(user).get();
		} catch {
			return DEFAULT_USER_SETTINGS;
		}
	};

	/**
	 * The background re-embed, one owner at a time: fill each CURRENT model's
	 * index, then drop that owner's other-model rows once covered. Doubled
	 * storage exists only during a switch, and an incomplete owner never
	 * loses their old index or another owner's rows.
	 */
	const pendingVectors = async () => {
		// Keep the existing backfill vectors trigger, but resolve one owner at
		// a time. NULL is the system scope and must never reuse a user's rows.
		for (const owner of db().itemOwners()) {
			const semanticDeps = await semantic(owner ?? undefined);
			if (semanticDeps === undefined) continue;
			const { embeddings: surface, current } = semanticDeps;
			await embedPending(
				db(),
				surface,
				current.model,
				current.local,
				entry,
				500,
				warnEmbedding,
				owner,
			);
			vectorGeneration += 1;
			if (db().modelCoverage(current.model, current.local, owner).complete) {
				db().deleteVectorsExcept(current.model, owner);
				vectorGeneration += 1;
			}
		}
	};
	const backfillDeps = () => ({
		host,
		capture: captureConversation,
		db: db(),
		vectors: pendingVectors,
		now: deps.now ?? Date.now,
	});
	function getServices() {
		maybeMigrateLocalProviders();
		if (services !== undefined) return services;
		const searcher = createSearcher({
			db: db(),
			meta,
			entry,
			isLocal,
			artifactStore: artifactStore(),
			vectors,
			now: deps.now ?? Date.now,
		});
		services = {
			searcher,
			tools: createTools({
				db: db(),
				searcher,
				artifactStore: artifactStore(),
				meta,
				entries: (conversationId, query, limit, cursor) =>
					host.conversations.entries(
						conversationId as ConversationId,
						{
							...query,
							minEntryId: query.minEntryId as EntryId | undefined,
							maxEntryId: query.maxEntryId as EntryId | undefined,
						},
						limit,
						cursor,
					),
				isLocal,
			}),
		};
		return services;
	}

	const extension = {
			name: "@sigrun/recall",
			hooks: [
				hook(ToolTask, {
					afterTool: async (call, result, api) => {
						// pi-durable 1.5.0 (spec §3.2-b): the harness runs afterTool
						// on results IT wrote for calls that never executed —
						// nothing to externalize from a call that never ran.
						if (!toolExecuted(result)) return undefined;
						try {
							const meta = await host.conversations.meta(api.conversationId);
							if (meta.internal === true) return undefined;
							const live = await settings.get();
							return externalize(result, call, {
								store: artifactStore(),
								thresholdBytes: live.externalizeBytes,
								conversationId: api.conversationId,
								owner: meta.owner ?? null,
								now: (deps.now ?? Date.now)(),
							});
						} catch (error) {
							console.error("recall: tool-result externalization failed", error);
							return undefined;
						}
					},
				}),
				hook(GenerationTask, {
					beforeRequest: async (request, api, context) => {
						try {
							const liveMeta = await host.conversations.meta(api.conversationId);
							const prefs =
								liveMeta.owner === undefined
									? DEFAULT_USER_SETTINGS
									: await userSettings(liveMeta.owner);
							const agent = await api.snapshot(AgentDoc, api.conversationId, context);
							const lineage = await loadLineage(api.conversationId, (query, limit, cursor) =>
								api.entries(
									{
										...query,
										minEntryId: query.minEntryId as EntryId | undefined,
										maxEntryId: query.maxEntryId as EntryId | undefined,
									},
									limit,
									cursor as never,
									context,
								),
							);
							const messages = await applyRecall(request.messages, {
								conversationId: api.conversationId,
								db: db(),
								searcher: getServices().searcher,
								meta: liveMeta,
								model: modelRef(agent?.model),
								autoRecall: prefs.autoRecall,
								internal: liveMeta.internal === true,
								inContext: { lineage },
								isLocal,
								sourceMeta: (id) => meta(id),
							});
							return messages === undefined ? undefined : { messages };
						} catch (error) {
							console.error("recall: automatic recall failed", error);
							return undefined;
						}
					},
				}),
			],
			get tools() {
				return getServices().tools;
			},
			get tasks() {
				return [createBackfillTask(backfillDeps)];
			},
	};

	return {
		title: "Recall",
		extension: defineExtension(extension),
		publishedHooks: createPublishedHooks({
			db,
			searcher: () => getServices().searcher,
			meta,
			now: deps.now ?? Date.now,
		}),
		jobs: [
			{
				name: "backfill",
				schedule: { cron: "*/10 * * * *" },
				action: { kind: "task", task: BACKFILL_TASK_NAME },
			},
		],
		routes: createRoutes({
			searcher: {
				search: (query, context, limit) => {
					maybeMigrateLocalProviders();
					return getServices().searcher.search(query, context, limit);
				},
			},
			sweep: () => runSweep(backfillDeps()),
		}),
		runSettled: async (event, api, context) => {
			try {
				const semanticDeps = await semantic();
				await captureConversation(
					{
						db: db(),
						meta: (id) => host.conversations.meta(id as ConversationId),
						now: deps.now ?? Date.now,
						// Named fields, not `...semanticDeps`: capture embeds
						// through the live default only (the search model and
						// the query budget are search-path concerns).
						embeddings: semanticDeps?.embeddings,
						warn: warnEmbedding,
						trackEmbedding,
					},
					event.conversationId,
					(query, limit, cursor) =>
						api.entries(
							{ ...query, minEntryId: query.minEntryId as EntryId | undefined },
							limit,
							cursor,
							context,
						),
				);
			} catch (error) {
				console.error("recall: conversation capture failed", error);
			}
		},
		harnessShutdown: async () => {
			const deadline = Date.now() + 30_000;
			while (pending.size > 0 && Date.now() < deadline) {
				const remaining = deadline - Date.now();
				// A capture promise may never settle (a hung embedding call);
				// race each round against the remaining budget so the drain
				// always returns by the deadline. The losing timer is cleared
				// so the common fast-settle case leaves no live timer behind.
				let timer: ReturnType<typeof setTimeout>;
				await Promise.race([
					Promise.allSettled([...pending]),
					new Promise<never[]>((resolve) => {
						timer = setTimeout(() => resolve([]), remaining);
					}),
				]).finally(() => clearTimeout(timer));
			}
			database?.close();
			database = undefined;
		},
	};
}
