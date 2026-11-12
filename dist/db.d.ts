import type { SittingRow, LineRow, MonthLineRow, SittingBlock, PreviousExchange } from "./sittings/types.js";
export type { SittingRow, LineRow, MonthLineRow, SittingBlock, PreviousExchange };
export type ItemKind = "turn" | "tool" | "artifact" | "doc";
export type Confidentiality = "normal" | "local-only";
export interface ItemRow {
    id: number;
    conversationId: number | null;
    owner: string | null;
    kind: ItemKind;
    entryId: number | null;
    messageIndex: number | null;
    blockIndex: number;
    offset: number;
    length: number;
    artifact: string | null;
    /** docs.id for kind "doc"; null otherwise. */
    doc: number | null;
    job: boolean;
    cls: Confidentiality;
    /** Milliseconds since the Unix epoch: the message's own time. */
    at: number;
    title: string | null;
}
export interface DocRow {
    id: number;
    provider: string;
    docId: string;
    owner: string;
    kind: string;
    title: string;
    url: string | null;
    at: number;
    cls: Confidentiality;
    /** Redacted full text; passages slice it for FTS. */
    text: string;
    sources: string[];
    updatedAt: number;
}
/**
 * The extension's private SQLite index. Callers close it during shutdown.
 *
 * `labelModel` is the model the v4 migration stamps on the vectors it
 * inherits from the pre-model schema: the caller passes
 * `openai/<old embedding model>` only when the old settings named a
 * model AND pointed at [OI]'s own endpoint (config's `migrationLabel`).
 * Without a label those rows land under `model = ""` — a key no real
 * model has, so they are re-embedded and later deleted.
 */
export declare class RecallDb {
    private readonly db;
    private constructor();
    static open(path: string, labelModel?: string): RecallDb;
    private migrate;
    insertItem(row: Omit<ItemRow, "id">, text: string): number | undefined;
    /**
     * Store a user-owned document and index its redacted text as "doc" items.
     * Identical content, title, date, class and sources leave the store untouched.
     */
    upsertDoc(doc: Omit<DocRow, "id" | "updatedAt">, now: number): {
        id: number;
        changed: boolean;
    };
    /** Delete a document, its items, FTS rows and vectors. */
    removeDoc(provider: string, owner: string, docId: string): boolean;
    doc(id: number): DocRow | undefined;
    docByKey(provider: string, owner: string, docId: string): DocRow | undefined;
    /** A slice of a document's stored redacted text, matching its passage rows. */
    docText(id: number, offset: number, length: number): string | undefined;
    /** Delete a document's items, removing their FTS rows and vectors first. */
    private deleteDocItems;
    putArtifact(hash: string, bytes: number, meta: {
        title?: string;
        url?: string;
        createdAt: number;
    }): void;
    item(id: number): ItemRow | undefined;
    itemByPassage(conversationId: number, entryId: number, messageIndex: number, blockIndex: number, offset: number): ItemRow | undefined;
    itemsForEntries(conversationId: number, entryIds: readonly number[]): ItemRow[];
    artifactHash(handle: string): string | undefined;
    itemByArtifact(handle: string): ItemRow | undefined;
    /** The first passage item of a document, for "d:<id>" handle resolution. */
    itemByDoc(doc: number): ItemRow | undefined;
    searchPorter(query: string, limit: number): {
        id: number;
        bm25: number;
    }[];
    searchTrigram(query: string, limit: number): {
        id: number;
        bm25: number;
    }[];
    private searchFts;
    /** Indexed text for one item from the porter FTS table. */
    itemText(id: number): string | undefined;
    /** Item ids matching a trigram FTS5 expression, in match order. */
    matchTrigram(expression: string): number[];
    upsertVector(itemId: number, model: string, vec: Float32Array): void;
    itemOwners(): readonly (string | null)[];
    listVectorsPage(model: string, after: number, limit: number, owner?: string | null): {
        itemId: number;
        vec: Buffer;
    }[];
    /**
     * Drop one owner's vectors that are not the given model's — the switch's
     * cleanup: only called once the new model covers that owner's items.
     */
    deleteVectorsExcept(model: string, owner?: string | null): void;
    state(key: string): string | undefined;
    setState(key: string, value: string): void;
    /**
     * Items with no vector for `model` — the embedPending work list. Items a
     * model may never embed (a non-local model's local-only items) are
     * filtered out by `includeLocalOnly`, not treated as pending. `after`
     * pages by item id for {@link modelCoverage}'s bounded scan.
     */
    listUnembeddedItems(model: string, limit: number, includeLocalOnly: boolean, after?: number, owner?: string | null): ItemRow[];
    /**
     * Whether the sweep could embed this item at all: a document item whose
     * document still exists, or a turn/tool item whose entry is addressable.
     * This is the structural "dangling" class {@link modelCoverage}
     * subtracts, and the same class `embedPending` skips — so the coverage
     * probe can never call an item covered that the sweep would refuse.
     *
     * Runtime skips are NOT dangling: an entry that fails to load or a
     * passage that no longer matches stays pending, so both the sweep and
     * the probe retry it rather than declare it done.
     */
    private embeddable;
    private docExists;
    /**
     * Whether `model` has a vector for every item it can embed: the eligible
     * list `listUnembeddedItems` returns, minus the items `embeddable` calls
     * structurally dangling, is empty. Local-only items a non-local model may
     * never embed are not counted against it (`includeLocalOnly`, exactly as
     * for the sweep).
     *
     * The caller deletes the previous model's rows once this says complete,
     * which is irreversible — so the probe returns `complete: false` the
     * moment ONE embeddable item lacks a vector, and gives up (also `false`)
     * rather than guess when the dangling backlog exceeds its bounded scan.
     */
    modelCoverage(model: string, includeLocalOnly: boolean, owner?: string | null): {
        complete: boolean;
    };
    cursor(conversationId: number): number | undefined;
    setCursor(conversationId: number, entryId: number): void;
    taintFrom(conversationId: number): number | undefined;
    setTaint(conversationId: number, entryId: number): void;
    private entryId;
    private setEntryId;
    putInjection(conversationId: number, messageKey: string, block: string, cls: Confidentiality, sources?: readonly number[]): void;
    injections(conversationId: number): ReadonlyMap<string, {
        block: string;
        cls: Confidentiality;
        sources: number[];
    }>;
    /** Read a stored boundary decision. `undefined` = never decided. */
    decision(conversationId: number, entryId: number): boolean | undefined;
    /** Stores a boundary decision; in practice callers record negatives, but the boolean round-trips. */
    putDecision(conversationId: number, entryId: number, boundary: boolean): void;
    /**
     * ONE transaction: positive decision + sitting row insert + previous line seal.
     * Returns `false` and writes NOTHING when a sitting row already exists for
     * (conversationId, startEntryId) — re-entrancy guard for `beforeRequest`.
     */
    createBoundary(row: SittingRow, sealPrevious: {
        startEntryId: number;
        line: {
            text: string;
            cls: "normal" | "local-only";
            coversThrough: number;
        };
    } | undefined): boolean;
    /** Sittings for the given conversations, ordered by startEntryId. */
    sittings(conversationIds: readonly number[]): SittingRow[];
    /** Insert-or-ignore: used for the first, non-boundary sitting. */
    putSitting(row: SittingRow): void;
    /** Update the title and title state of a sitting. */
    setSittingTitle(conversationId: number, startEntryId: number, title: string | null, state: SittingRow["titleState"]): void;
    /** Lines for the given conversations. */
    lines(conversationIds: readonly number[]): LineRow[];
    /** Write a draft line; no-op if the row is already sealed. */
    putLineDraft(row: Omit<LineRow, "sealed">): void;
    /** Upsert a line as sealed with exactly this content; no-op when already sealed. */
    sealLine(conversationId: number, startEntryId: number, line: {
        text: string;
        cls: "normal" | "local-only";
        coversThrough: number;
    }): void;
    /** Month lines for the given conversations. */
    monthLines(conversationIds: readonly number[]): MonthLineRow[];
    /** Insert-or-ignore: written once per month. */
    putMonthLine(row: MonthLineRow): void;
    close(): void;
}
