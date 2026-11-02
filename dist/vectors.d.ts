import type { Embedder } from "./embed.js";
import type { RecallDb } from "./db.js";
import type { VectorArm } from "./search.js";
export interface VectorIndex {
    upsert(itemId: number, vec: Float32Array): void;
    query(vec: Float32Array, k: number, signal?: AbortSignal): {
        itemId: number;
        score: number;
    }[];
}
/** Store vectors in SQLite and scan bounded pages for cosine nearest neighbours. */
export declare function createSqliteVectorIndex(db: RecallDb, pageSize?: number): VectorIndex;
/** Add a semantic arm that degrades to lexical search on embedding failure. */
export declare function createVectorArm(embedder: Embedder, index: VectorIndex, timeoutMs: number): VectorArm;
