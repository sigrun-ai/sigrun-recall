import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Sharing } from "@sigrun/shared/access";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import type { ArtifactStore } from "./artifacts.js";
import type { ItemKind, ItemRow, RecallDb } from "./db.js";
import type { InContextRule } from "./sittings/lineage.js";
export interface SearchContext {
    /** Acting directory user; undefined selects the system embedding default. */
    user?: string;
    current: {
        conversationId: number | undefined;
        owner?: string;
        sharing?: Sharing;
    };
    model: {
        provider: string;
        id: string;
    } | undefined;
    /** Material already visible in the current model context is not recalled. */
    inContext?: InContextRule;
    excludeConversation?: number;
    includeJobs: boolean;
    /** Inclusive message-time lower bound. */
    since?: number;
    /** Exclusive message-time upper bound. */
    until?: number;
    kinds?: readonly ItemKind[];
}
export interface Hit {
    item: ItemRow;
    score: number;
    snippet: string;
    handle: string;
    conversationTitle: string | null;
}
export interface Searcher {
    search(query: string, ctx: SearchContext, limit: number): Promise<Hit[]>;
}
export interface VectorArm {
    query(text: string, candidateLimit: number): Promise<{
        itemId: number;
        rank: number;
    }[]>;
}
export declare function createSearcher(deps: {
    db: RecallDb;
    meta(id: number): Promise<SessionMeta>;
    entry(conversationId: number, entryId: number): Promise<EntryRecord | undefined>;
    isLocal(model: string): boolean;
    vectors?: (user: string | undefined) => Promise<VectorArm | undefined>;
    artifactStore?: ArtifactStore;
    now(): number;
}): Searcher;
