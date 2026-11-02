export type ItemKind = "turn" | "tool" | "artifact";
export type Confidentiality = "normal" | "local-only";
export interface ItemRow {
    id: number;
    conversationId: number;
    owner: string | null;
    kind: ItemKind;
    entryId: number | null;
    messageIndex: number | null;
    offset: number;
    length: number;
    artifact: string | null;
    job: boolean;
    cls: Confidentiality;
    /** Milliseconds since the Unix epoch: the message's own time. */
    at: number;
    title: string | null;
}
/** The extension's private SQLite index. Callers close it during shutdown. */
export declare class RecallDb {
    private readonly db;
    private constructor();
    static open(path: string): RecallDb;
    private migrate;
    insertItem(row: Omit<ItemRow, "id">, text: string): number | undefined;
    putArtifact(hash: string, bytes: number, meta: {
        title?: string;
        url?: string;
        createdAt: number;
    }): void;
    item(id: number): ItemRow | undefined;
    itemByPassage(conversationId: number, entryId: number, messageIndex: number, offset: number): ItemRow | undefined;
    itemByArtifact(handle: string): ItemRow | undefined;
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
    listUnembeddedItems(limit: number): ItemRow[];
    cursor(conversationId: number): number | undefined;
    setCursor(conversationId: number, entryId: number): void;
    taintFrom(conversationId: number): number | undefined;
    setTaint(conversationId: number, entryId: number): void;
    private entryId;
    private setEntryId;
    putInjection(conversationId: number, messageKey: string, block: string, cls: Confidentiality): void;
    injections(conversationId: number): ReadonlyMap<string, {
        block: string;
        cls: Confidentiality;
    }>;
    close(): void;
}
