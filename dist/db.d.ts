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
/** The extension's private SQLite index. Callers close it during shutdown. */
export declare class RecallDb {
    private readonly db;
    private constructor();
    static open(path: string): RecallDb;
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
    upsertVector(itemId: number, vec: Float32Array): void;
    listVectorsPage(after: number, limit: number): {
        itemId: number;
        vec: Buffer;
    }[];
    state(key: string): string | undefined;
    setState(key: string, value: string): void;
    listUnembeddedItems(limit: number, includeLocalOnly: boolean): ItemRow[];
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
    close(): void;
}
