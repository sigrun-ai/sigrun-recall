import { Type, type Static } from "@earendil-works/pi-ai";
import type { PublishedHook } from "@sigrun/sigrun/extension";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import type { RecallDb } from "./db.js";
import type { Searcher } from "./search.js";
export declare const RecallIndexInput: Type.TObject<{
    id: Type.TString;
    kind: Type.TString;
    title: Type.TString;
    text: Type.TString;
    date: Type.TString;
    url: Type.TOptional<Type.TString>;
    class: Type.TOptional<Type.TUnion<[Type.TLiteral<"normal">, Type.TLiteral<"local-only">]>>;
    sources: Type.TOptional<Type.TArray<Type.TString>>;
}>;
export type RecallIndexInput = Static<typeof RecallIndexInput>;
export declare const RecallIndexOutput: Type.TObject<{
    handle: Type.TString;
    class: Type.TUnion<[Type.TLiteral<"normal">, Type.TLiteral<"local-only">]>;
    changed: Type.TBoolean;
}>;
export type RecallIndexOutput = Static<typeof RecallIndexOutput>;
export declare const RecallRemoveInput: Type.TObject<{
    id: Type.TString;
}>;
export type RecallRemoveInput = Static<typeof RecallRemoveInput>;
export declare const RecallRemoveOutput: Type.TObject<{
    removed: Type.TBoolean;
}>;
export type RecallRemoveOutput = Static<typeof RecallRemoveOutput>;
export declare const RecallSearchInput: Type.TObject<{
    query: Type.TString;
    limit: Type.TOptional<Type.TInteger>;
    kinds: Type.TOptional<Type.TArray<Type.TUnion<[Type.TLiteral<"turn">, Type.TLiteral<"tool">, Type.TLiteral<"artifact">, Type.TLiteral<"doc">]>>>;
    model: Type.TOptional<Type.TObject<{
        provider: Type.TString;
        modelId: Type.TString;
    }>>;
}>;
export type RecallSearchInput = Static<typeof RecallSearchInput>;
export declare const RecallSearchOutput: Type.TObject<{
    hits: Type.TArray<Type.TObject<{
        handle: Type.TString;
        kind: Type.TUnion<[Type.TLiteral<"turn">, Type.TLiteral<"tool">, Type.TLiteral<"artifact">, Type.TLiteral<"doc">]>;
        title: Type.TString;
        date: Type.TString;
        snippet: Type.TString;
        class: Type.TUnion<[Type.TLiteral<"normal">, Type.TLiteral<"local-only">]>;
        provider: Type.TOptional<Type.TString>;
        id: Type.TOptional<Type.TString>;
    }>>;
}>;
export type RecallSearchOutput = Static<typeof RecallSearchOutput>;
export interface PublishedHooksDeps {
    db(): RecallDb;
    searcher(): Searcher;
    meta(id: number): Promise<SessionMeta>;
    now(): number;
}
/**
 * The extension-to-extension seam: named, schema-validated hooks other
 * extensions call through the core registry (see Task 2's PublishedHook).
 * Docs are keyed (call.caller, call.user, id) so one extension can never
 * overwrite another's record.
 */
export declare function createPublishedHooks(deps: PublishedHooksDeps): readonly PublishedHook[];
