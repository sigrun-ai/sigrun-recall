import type { EntryRecord } from "@earendil-works/pi-durable";
import type { ItemRow } from "../db.js";
export interface LineageLink {
    conversationId: number;
    throughEntryId: number;
    throughAt: number;
}
export type EntriesReader = (query: {
    minEntryId?: number;
    maxEntryId?: number;
    order: "ascending" | "descending";
}, limit: number, cursor: unknown) => Promise<{
    readonly items: readonly EntryRecord[];
    readonly next?: unknown;
}>;
export interface InContextRule {
    lineage: readonly LineageLink[];
    boundary?: {
        entryId: number;
        at: number;
    };
}
export type LineageMemo = Map<number, Promise<LineageLink[]>>;
export declare function createLineageMemo(): LineageMemo;
export interface LoadLineageOptions {
    memo?: LineageMemo;
    pageSize?: number;
}
/**
 * Derive each inherited conversation's fork point from the raw entries.
 * Pass `options.memo` to memoize; without it the memo is throwaway for a
 * one-shot caller, so repeated calls read the entries again.
 */
export declare function loadLineage(conversationId: number, read: EntriesReader, options?: LoadLineageOptions): Promise<LineageLink[]>;
/** Whether an indexed item is already visible in the request's model context. */
export declare function inContext(item: ItemRow, rule: InContextRule): boolean;
