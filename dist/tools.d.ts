import type { Cursor, EntryRecord, Page, ToolRegistration } from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import type { ArtifactStore } from "./artifacts.js";
import type { RecallDb } from "./db.js";
import type { Searcher } from "./search.js";
export interface ToolsDeps {
    db: RecallDb;
    searcher: Searcher;
    artifactStore: ArtifactStore;
    meta(id: number): Promise<SessionMeta>;
    entries(conversationId: number, query: {
        minEntryId?: number;
        maxEntryId?: number;
        order: "ascending";
    }, limit: number, cursor?: Cursor): Promise<Page<EntryRecord, Cursor>>;
    localProviders(user: string): Promise<readonly string[]>;
}
/** Build the read-only model-facing recall tools. */
export declare function createTools(deps: ToolsDeps): readonly ToolRegistration[];
