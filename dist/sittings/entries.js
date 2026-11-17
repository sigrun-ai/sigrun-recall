import { attachmentNames, isUserInput, typedText } from "@sigrun/shared/turns";
import { messageKey } from "../message-key.js";
/**
 * Map the newest user message to its user input entry by reading entries
 * descending and matching the model message's timestamp and messageKey.
 */
export async function findUserEntry(read, newest, options) {
    const key = messageKey(newest);
    let cursor;
    for (let pageNumber = 0; options?.maxPages === undefined || pageNumber < options.maxPages; pageNumber += 1) {
        const page = await read({ order: "descending" }, 200, cursor);
        for (const entry of page.items) {
            if (!isUserInput(entry))
                continue;
            const model = entry.model?.[0];
            if (model !== undefined &&
                model.role === "user" &&
                model.timestamp === newest.timestamp &&
                messageKey(model) === key) {
                return entry;
            }
        }
        if (page.next === undefined)
            return undefined;
        cursor = page.next;
    }
    return undefined;
}
/**
 * The boundary/recall query text of a user input entry: its typed text,
 * or — for an attachments-only message — the attachment names, so an
 * empty typed message never degenerates into an empty query, an empty
 * boundaryText or a dangling TOC line.
 *
 * Only the typed branch is trimmed: the name list is used as-is (the
 * caller appends ` <name>` directly after it).
 */
export function entryQueryText(entry) {
    return typedText(entry, " ").trim() || attachmentNames(entry, " ");
}
