import { join } from "node:path";
import { defineExtension, hook, ToolTask, } from "@earendil-works/pi-durable";
import { createArtifactStore, externalize } from "./artifacts.js";
import { captureConversation } from "./capture.js";
import { resolveSettings } from "./config.js";
import { RecallDb } from "./db.js";
import { createEmbedder } from "./embed.js";
import { createSqliteVectorIndex, createVectorArm } from "./vectors.js";
/**
 * The loader injects the host only when factory.length > 0: keep the host
 * bare and the optional test dependencies second, so the arity stays one.
 */
export default function createRecall(host, deps = {}) {
    let database;
    let embedder;
    // Capture/search surfaces added by later tasks share this one lazy handle.
    // Core does not create paths.data; RecallDb.open creates its parent.
    function db() {
        database ??= (deps.openDb ?? RecallDb.open)(join(host.stores.paths.data, "recall.db"));
        return database;
    }
    async function semantic() {
        const settings = await resolveSettings(host.stores.settings);
        if (settings.embedding === undefined)
            return {};
        embedder ??= createEmbedder(settings.embedding, () => host.stores.secrets.get("embedding-api-key"));
        return { embedder, index: createSqliteVectorIndex(db()) };
    }
    // Task 8/10 consumes this accessor when constructing the Searcher.
    async function vectors() {
        const semanticDeps = await semantic();
        if (semanticDeps.embedder === undefined || semanticDeps.index === undefined) {
            return undefined;
        }
        const timeoutMs = (await resolveSettings(host.stores.settings)).embedding.timeoutMs;
        return createVectorArm(semanticDeps.embedder, semanticDeps.index, timeoutMs);
    }
    void vectors;
    return {
        extension: defineExtension({
            name: "@sigrun/recall",
            hooks: [
                hook(ToolTask, {
                    afterTool: async (call, result, api) => {
                        try {
                            const meta = await host.conversations.meta(api.conversationId);
                            if (meta.internal === true)
                                return undefined;
                            const settings = await resolveSettings(host.stores.settings);
                            return externalize(result, call, {
                                store: createArtifactStore(db(), join(host.stores.paths.data, "artifacts")),
                                thresholdBytes: settings.externalizeBytes,
                                conversationId: api.conversationId,
                                owner: meta.owner ?? null,
                                now: (deps.now ?? Date.now)(),
                            });
                        }
                        catch (error) {
                            console.error("recall: tool-result externalization failed", error);
                            return undefined;
                        }
                    },
                }),
            ],
        }),
        runSettled: async (event, api, context) => {
            try {
                const semanticDeps = await semantic();
                await captureConversation({
                    db: db(),
                    meta: (id) => host.conversations.meta(id),
                    now: deps.now ?? Date.now,
                    ...semanticDeps,
                }, event.conversationId, (query, limit, cursor) => api.entries({ ...query, minEntryId: query.minEntryId }, limit, cursor, context));
            }
            catch (error) {
                console.error("recall: conversation capture failed", error);
            }
        },
    };
}
