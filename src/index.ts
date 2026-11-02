import { join } from "node:path";

import {
	defineExtension,
	type ConversationId,
	type EntryId,
} from "@earendil-works/pi-durable";
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";

import { captureConversation } from "./capture.js";
import { RecallDb } from "./db.js";

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

	// Capture/search surfaces added by later tasks share this one lazy handle.
	// Core does not create paths.data; RecallDb.open creates its parent.
	function db(): RecallDb {
		database ??= (deps.openDb ?? RecallDb.open)(
			join(host.stores.paths.data, "recall.db"),
		);
		return database;
	}
	return {
		extension: defineExtension({ name: "@sigrun/recall" }),
		runSettled: async (event, api, context) => {
			try {
				await captureConversation(
					{
						db: db(),
						meta: (id) => host.conversations.meta(id as ConversationId),
						now: deps.now ?? Date.now,
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
