import type { Message, UserMessage } from "@earendil-works/pi-ai";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import type { Confidentiality, RecallDb } from "./db.js";
import type { Hit, Searcher } from "./search.js";
import type { InContextRule } from "./sittings/lineage.js";
export interface InjectDeps {
    conversationId: number;
    db: RecallDb;
    searcher: Searcher;
    meta: SessionMeta;
    model: {
        provider: string;
        id: string;
    } | undefined;
    autoRecall: boolean;
    internal: boolean;
    /** The lineage and boundary of the current request's visible context. */
    inContext: InContextRule;
    /** Boundary messages use the sitting block, not ordinary auto-recall. */
    skipTimestamps?: ReadonlySet<number>;
    /** The admin's live locality switch; unknown sources fail closed. */
    isLocal: (model: string) => boolean;
    /** Live source metadata; a missing reader fails closed for sourced blocks. */
    sourceMeta?: (conversationId: number) => Promise<SessionMeta>;
}
/** Stable identity of a user message for per-message injection reuse. */
export declare function messageKey(message: UserMessage): string;
/** Render stable, untrusted reference material within the snippet byte budget. */
export declare function renderBlock(hits: readonly Hit[]): string;
/** Recheck every stored source against its live metadata and the current model. */
export declare function injectionReadable(injection: {
    cls: Confidentiality;
    sources: readonly number[];
}, deps: InjectDeps): Promise<boolean>;
/** Search once per newest message and apply all currently readable stored blocks. */
export declare function applyRecall(messages: readonly Message[], deps: InjectDeps): Promise<readonly Message[] | undefined>;
