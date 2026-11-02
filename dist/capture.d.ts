import type { Cursor, EntryRecord, Page } from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import type { RecallDb } from "./db.js";
import type { Embedder } from "./embed.js";
import type { VectorIndex } from "./vectors.js";
export interface CaptureDeps {
    db: RecallDb;
    meta(id: number): Promise<SessionMeta>;
    now(): number;
    /** Optional best-effort semantic indexing; capture never awaits embedding. */
    embedder?: Embedder;
    index?: VectorIndex;
}
export type EntryReader = (query: {
    minEntryId?: number;
    order: "ascending";
}, limit: number, cursor?: Cursor) => Promise<Page<EntryRecord, Cursor>>;
/** Index newly settled conversation entries, resuming from the saved cursor. */
export declare function captureConversation(deps: CaptureDeps, conversationId: number, read: EntryReader): Promise<{
    indexed: number;
}>;
