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
import { resolveSettings, resolveUserSettings } from "./config.js";
import { RecallDb } from "./db.js";
import { createPublishedHooks } from "./hooks.js";
import { createSearcher } from "./search.js";
import { toolExecuted } from "./tool-executed.js";
import { createRoutes } from "./route.js";
import { createTools } from "./tools.js";
import { createEmbedder } from "./embed.js";
import { applyRecall } from "./inject.js";
import { createSqliteVectorIndex, createVectorArm, embedPending } from "./vectors.js";

export {
	RecallIndexInput,
	RecallIndexOutput,
	RecallRemoveInput,
	RecallRemoveOutput,
	RecallSearchInput,
	RecallSearchOutput,
} from "./hooks.js";

export interface FactoryDeps {
	openDb?: (path: string) => RecallDb;
	now?: () => number;
	/** Test seam: fetch implementation for the embeddings endpoint. */
	fetchImpl?: typeof fetch;
}

/**
 * The loader injects the host only when factory.length > 0: keep the host
 * bare and the optional test dependencies second, so the arity stays one.
 */
export default function createRecall(
	host: SigrunHost,
	deps: FactoryDeps = {},
): SigrunExtensionResult {
	let database: RecallDb | undefined;
	let embedder: ReturnType<typeof createEmbedder> | undefined;
	let embedderError: unknown;
	let embeddingKey: string | undefined;
	let services: {
		searcher: ReturnType<typeof createSearcher>;
		tools: ReturnType<typeof createTools>;
	} | undefined;
	const pending = new Set<Promise<void>>();
	const trackEmbedding = (work: Promise<void>) => {
		pending.add(work);
		void work.finally(() => pending.delete(work));
	};

	// Capture/search surfaces added by later tasks share this one lazy handle.
	// Core does not create paths.data; RecallDb.open creates its parent.
	function db(): RecallDb {
		database ??= (deps.openDb ?? RecallDb.open)(
			join(host.stores.paths.data, "recall.db"),
		);
		return database;
	}

	async function semantic() {
		const settings = await resolveSettings(host.stores.settings);
		if (settings.embedding === undefined) return {};
		const key = JSON.stringify(settings.embedding);
		if (embedder === undefined || embeddingKey !== key || embedderError !== undefined) {
			embedderError = undefined;
			embedder = createEmbedder(
				settings.embedding,
				() => host.stores.secrets.get("embedding-api-key"),
				deps.fetchImpl,
			);
			embeddingKey = key;
		}
		return {
			embedder,
			index: createSqliteVectorIndex(db()),
			timeoutMs: settings.embedding.timeoutMs,
		};
	}

	async function vectors() {
		let semanticDeps;
		try {
			semanticDeps = await semantic();
		} catch (error) {
			// Settings can transiently fail to read; degrade to lexical and let
			// the next call retry instead of permanently caching the failure.
			embedderError = error;
			console.error("recall: semantic search configuration failed", error);
			return undefined;
		}
		if (
			semanticDeps.embedder === undefined ||
			semanticDeps.index === undefined ||
			semanticDeps.timeoutMs === undefined
		) {
			return undefined;
		}
		return createVectorArm(
			semanticDeps.embedder,
			semanticDeps.index,
			semanticDeps.timeoutMs,
		);
	}

	let artifacts: ReturnType<typeof createArtifactStore> | undefined;
	const artifactStore = () =>
		(artifacts ??= createArtifactStore(db(), join(host.stores.paths.data, "artifacts")));
	const meta = (id: number) => host.conversations.meta(id as ConversationId);
	const entry = (conversationId: number, entryId: number) =>
		host.conversations.entry(conversationId as ConversationId, entryId as EntryId);
	const DEFAULT_USER_SETTINGS = { autoRecall: true, localProviders: [] } as const;
	const userSettings = async (user: string) => {
		try {
			return await resolveUserSettings(host.stores.user(user).settings);
		} catch {
			return DEFAULT_USER_SETTINGS;
		}
	};
	const localProviders = async (user: string) => (await userSettings(user)).localProviders;
	const pendingVectors = async () => {
		const semanticDeps = await semantic();
		if (semanticDeps.embedder !== undefined && semanticDeps.index !== undefined) {
			await embedPending(db(), semanticDeps.embedder, semanticDeps.index, entry, 500);
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
		if (services !== undefined) return services;
		const searcher = createSearcher({
			db: db(),
			meta,
			entry,
			userSettings,
			artifactStore: artifactStore(),
			vectors: {
				query: async (text, limit) => (await vectors())?.query(text, limit) ?? [],
			},
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
				localProviders,
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
							const settings = await resolveSettings(host.stores.settings);
							return externalize(result, call, {
								store: artifactStore(),
								thresholdBytes: settings.externalizeBytes,
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
							const settings =
								liveMeta.owner === undefined
									? DEFAULT_USER_SETTINGS
									: await userSettings(liveMeta.owner);
							const agent = await api.snapshot(AgentDoc, api.conversationId, context);
							const messages = await applyRecall(request.messages, {
								conversationId: api.conversationId,
								db: db(),
								searcher: getServices().searcher,
								meta: liveMeta,
								model: agent?.model,
								autoRecall: settings.autoRecall,
								internal: liveMeta.internal === true,
								ownerLocalProviders: settings.localProviders,
								sourceMeta: (id) => meta(id),
								sourceLocalProviders: localProviders,
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
				search: (query, context, limit) => getServices().searcher.search(query, context, limit),
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
						...semanticDeps,
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
				// A capture promise may never settle (a hung embedding fetch); race
				// each round against the remaining budget so the drain always
				// returns by the deadline. The losing timer is cleared so the
				// common fast-settle case leaves no live timer behind.
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
