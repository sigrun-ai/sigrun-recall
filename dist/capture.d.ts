import type { Cursor, EntryRecord, Page } from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import type { RecallDb } from "./db.js";
import type { EmbeddingHost, EmbeddingWarning } from "./vectors.js";
export interface CaptureDeps {
    db: RecallDb;
    meta(id: number): Promise<SessionMeta>;
    now(): number;
    /**
     * Optional best-effort semantic indexing; capture never awaits
     * embedding. No `model` is requested (the live `embeddingModel`
     * default decides) and vectors are stored under the model the
     * provider RETURNED, so a provider that resolves a different model
     * still lands its vectors in the right space.
     */
    embeddings?: EmbeddingHost;
    trackEmbedding?: (work: Promise<void>) => void;
    warn?: EmbeddingWarning;
}
export type EntryReader = (query: {
    minEntryId?: number;
    order: "ascending";
}, limit: number, cursor?: Cursor) => Promise<Page<EntryRecord, Cursor>>;
/** Index newly settled conversation entries, resuming from the saved cursor. */
export declare function captureConversation(deps: CaptureDeps, conversationId: number, read: EntryReader): Promise<{
    indexed: number;
}>;
