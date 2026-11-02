import type { Cursor, EntryRecord, Page } from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import type { RecallDb } from "./db.js";
export interface CaptureDeps {
    db: RecallDb;
    meta(id: number): Promise<SessionMeta>;
    now(): number;
}
export type EntryReader = (query: {
    minEntryId?: number;
    order: "ascending";
}, limit: number, cursor?: Cursor) => Promise<Page<EntryRecord, Cursor>>;
/** Index newly settled conversation entries, resuming from the saved cursor. */
export declare function captureConversation(deps: CaptureDeps, conversationId: number, read: EntryReader): Promise<{
    indexed: number;
}>;
