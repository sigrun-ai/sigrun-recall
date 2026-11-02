import { join } from "node:path";

import {
	defineExtension,
	hook,
	ToolTask,
	type ConversationId,
	type EntryId,
} from "@earendil-works/pi-durable";
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";

import { createArtifactStore, externalize } from "./artifacts.js";
import { captureConversation } from "./capture.js";
import { resolveSettings, resolveUserSettings } from "./config.js";
import { RecallDb } from "./db.js";
import { createSearcher } from "./search.js";
import { createTools } from "./tools.js";
import { createEmbedder } from "./embed.js";
import { createSqliteVectorIndex, createVectorArm } from "./vectors.js";

export interface FactoryDeps {
	openDb?: (path: string) => RecallDb;
	now?: () => number;
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
		embedder ??= createEmbedder(settings.embedding, () =>
			host.stores.secrets.get("embedding-api-key"),
		);
		return {
			embedder,
			index: createSqliteVectorIndex(db()),
			timeoutMs: settings.embedding.timeoutMs,
		};
	}

	// Task 8/10 consumes this accessor when constructing the Searcher.
	async function vectors() {
		const semanticDeps = await semantic();
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
	void vectors;

	const artifactStore = () =>
		createArtifactStore(db(), join(host.stores.paths.data, "artifacts"));
	const meta = (id: number) => host.conversations.meta(id as ConversationId);
	const entry = (conversationId: number, entryId: number) =>
		host.conversations.entry(conversationId as ConversationId, entryId as EntryId);
	const localProviders = async (user: string) => {
		try {
			return (await resolveUserSettings(host.stores.user(user).settings)).localProviders;
		} catch {
			return [];
		}
	};
	const toolDb = db();
	const toolArtifactStore = artifactStore();

	return {
		extension: defineExtension({
			name: "@sigrun/recall",
			hooks: [
				hook(ToolTask, {
					afterTool: async (call, result, api) => {
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
			],
			tools: createTools({
				db: toolDb,
				searcher: createSearcher({
					db: toolDb,
					meta,
					entry,
					userSettings: async (user) => {
						try {
							return await resolveUserSettings(host.stores.user(user).settings);
						} catch {
							return { autoRecall: true, localProviders: [] };
						}
					},
					artifactStore: toolArtifactStore,
					now: deps.now ?? Date.now,
				}),
				artifactStore: toolArtifactStore,
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
	};
}
