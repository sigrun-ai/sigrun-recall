import type { UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { EntriesReader } from "./lineage.js";
/**
 * Map the newest user message to its user input entry by reading entries
 * descending and matching the model message's timestamp and messageKey.
 */
export declare function findUserEntry(read: EntriesReader, newest: UserMessage, options?: {
    readonly maxPages?: number;
}): Promise<EntryRecord | undefined>;
/**
 * The boundary/recall query text of a user input entry: its typed text,
 * or — for an attachments-only message — the attachment names, so an
 * empty typed message never degenerates into an empty query, an empty
 * boundaryText or a dangling TOC line.
 *
 * Only the typed branch is trimmed: the name list is used as-is (the
 * caller appends ` <name>` directly after it).
 */
export declare function entryQueryText(entry: EntryRecord): string;
