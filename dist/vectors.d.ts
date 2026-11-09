import type { EntryRecord } from "@earendil-works/pi-durable";
import type { EmbeddingResult } from "@sigrun/shared/embeddings";
import type { RecallDb } from "./db.js";
import type { VectorArm } from "./search.js";
/** One row of `host.embeddings.list()` (core's registry shape). */
export interface EmbeddingModelRow {
    /** `provider/model`. */
    readonly model: string;
    readonly provider: string;
    readonly dimensions: number;
    /** Core's gate: the admin listed it AND its provider did not veto. */
    readonly local: boolean;
    /**
     * The row the live `embeddingModel` setting resolves to. Core's
     * registry emits this on every row; the published `SigrunHost`
     * contract type omits it (see the task report), so recall declares
     * it structurally and treats an absent field as `false`.
     */
    readonly default?: boolean;
    readonly status: "not_configured" | "degraded" | "ready";
}
/**
 * The `host.embeddings` slice recall uses, declared structurally (the
 * `src/host.ts` discipline the rest of this repo follows): recall never
 * imports core's runtime, only the result type the contract itself names.
 */
export interface EmbeddingHost {
    embed(texts: readonly string[], opts?: {
        model?: string;
        confidentiality?: "normal" | "local-only";
        signal?: AbortSignal;
        timeoutMs?: number;
    }): Promise<EmbeddingResult>;
    list(): Promise<readonly EmbeddingModelRow[]>;
}
export interface VectorIndex {
    upsert(itemId: number, vec: Float32Array): void;
    query(vec: Float32Array, k: number, signal?: AbortSignal): {
        itemId: number;
        score: number;
    }[];
}
export type EmbeddingWarning = (code: string, message: string) => void;
/**
 * A per-code warning throttle: a misconfigured provider fails every page
 * and every query, so a per-call log would drown the operator. Each code
 * speaks at most once a minute — long enough to stay quiet, short enough
 * that a transient `failed` cannot go silent for the whole process.
 *
 * `not_local` and `no_model` are expected states (local-only material on a
 * shared model; embeddings simply not configured) and never warn: the
 * items remain lexical, which is the documented behaviour.
 */
export declare function createEmbeddingWarnings(now?: () => number, windowMs?: number): EmbeddingWarning;
/**
 * The process-wide throttle a caller gets when it does not inject one, so
 * library users and the capture page share ONE budget per code instead of
 * starting a fresh one per call.
 */
export declare const DEFAULT_EMBEDDING_WARNINGS: EmbeddingWarning;
/** Store vectors in SQLite and scan bounded pages for cosine nearest neighbours. */
export declare function createSqliteVectorIndex(db: RecallDb, model: string, pageSize?: number): VectorIndex;
/**
 * One embedding call for one confidentiality class. `host.embeddings.embed`
 * never throws and splits above the provider's batch size itself, so a page
 * needs exactly one call per class, not a recall-side chunker.
 *
 * `confidentiality: "local-only"` with a model core does not trust for local
 * material comes back `not_local`; the whole batch then stays lexical rather
 * than leaking, which is the documented outcome. Vectors are stored under the
 * model the provider RETURNED, never a recall-side guess.
 */
export declare function embedClass(embeddings: EmbeddingHost, upsert: (itemId: number, model: string, vec: Float32Array) => void, batch: readonly {
    id: number;
    text: string;
}[], confidentiality: "normal" | "local-only", model: string | undefined, warn: EmbeddingWarning): Promise<void>;
/**
 * Embed up to `limit` unembedded conversation passages from their source
 * entries. Local-only items ride `includeLocalOnly` (a model core trusts
 * for local material) and are submitted with `confidentiality:
 * "local-only"`; the rest go as `normal`.
 */
export declare function embedPending(db: RecallDb, embeddings: EmbeddingHost, model: string, modelIsLocal: boolean, entry: (conversationId: number, entryId: number) => Promise<EntryRecord | undefined>, limit?: number, warn?: EmbeddingWarning): Promise<void>;
/**
 * Add a semantic arm over `model`'s index. The QUERY is embedded with
 * that same model — the index is model-scoped, so a query embedded by a
 * different model would compare vectors from two spaces. Failures
 * degrade to lexical search (the vector arm simply contributes nothing).
 */
export declare function createVectorArm(embeddings: EmbeddingHost, index: VectorIndex, model: string, timeoutMs: number, warn?: EmbeddingWarning): VectorArm;
