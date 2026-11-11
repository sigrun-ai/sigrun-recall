import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
import { RecallDb } from "./db.js";
export { RecallIndexInput, RecallIndexOutput, RecallRemoveInput, RecallRemoveOutput, RecallSearchInput, RecallSearchOutput, } from "./hooks.js";
export interface FactoryDeps {
    openDb?: (path: string, labelModel?: string) => RecallDb;
    now?: () => number;
}
/**
 * The loader injects the host only when factory.length > 0: keep the host
 * bare and the optional test dependencies second, so the arity stays one.
 *
 * Async for the raw migration-label read and the once-per-boot
 * local-providers migration sweep.
 */
export default function createRecall(host: SigrunHost, deps?: FactoryDeps): Promise<SigrunExtensionResult>;
