import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
import { RecallDb } from "./db.js";
export { RecallIndexInput, RecallIndexOutput, RecallRemoveInput, RecallRemoveOutput, RecallSearchInput, RecallSearchOutput, } from "./hooks.js";
export interface FactoryDeps {
    openDb?: (path: string, labelModel?: string) => RecallDb;
    now?: () => number;
    /** Test seam: fetch implementation for the embeddings endpoint. */
    fetchImpl?: typeof fetch;
}
/**
 * The loader injects the host only when factory.length > 0: keep the host
 * bare and the optional test dependencies second, so the arity stays one.
 *
 * Async for ONE reason: the v4 vectors migration stamps the vectors it
 * inherits from the pre-model schema with the model the OLD settings named,
 * and that label must be known before the database is first opened (which
 * happens lazily, from synchronous call sites).
 */
export default function createRecall(host: SigrunHost, deps?: FactoryDeps): Promise<SigrunExtensionResult>;
