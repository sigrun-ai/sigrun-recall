import type { ToolExecutionResult, ToolHookCall } from "@earendil-works/pi-durable";
import type { RecallDb } from "./db.js";
export interface ArtifactStore {
    put(text: string, meta: {
        title?: string;
        url?: string;
        conversationId: number;
        owner: string | null;
        at: number;
    }): {
        handle: string;
        bytes: number;
    };
    read(handle: string, offset: number, length: number): string | undefined;
}
/** Store whole tool results by content hash and index their searchable text. */
export declare function createArtifactStore(db: RecallDb, dir: string): ArtifactStore;
/** Return markdown headings, or fixed-size part markers for unheaded text. */
export declare function outline(text: string): {
    title: string;
    offset: number;
}[];
/** Render the retained head and bounded navigation stub for an artifact. */
export declare function renderStub(text: string, handle: string, headBytes: 6144): string;
/** Replace only large, complete top-level tool output with an artifact stub. */
export declare function externalize(result: ToolExecutionResult, call: ToolHookCall, deps: {
    store: ArtifactStore;
    thresholdBytes: number;
    conversationId: number;
    owner: string | null;
    now: number;
}): ToolExecutionResult | undefined;
