import { passagesOf } from "./passages.js";
import { redact } from "./redact.js";
const PAGE_SIZE = 200;
/** Index newly settled conversation entries, resuming from the saved cursor. */
export async function captureConversation(deps, conversationId, read) {
    const meta = await deps.meta(conversationId);
    if (meta.internal === true)
        return { indexed: 0 };
    const savedCursor = deps.db.cursor(conversationId);
    const query = { order: "ascending" };
    if (savedCursor !== undefined)
        query.minEntryId = savedCursor + 1;
    const taintFrom = deps.db.taintFrom(conversationId);
    let indexed = 0;
    let cursor;
    do {
        const page = await read(query, PAGE_SIZE, cursor);
        for (const entry of page.items) {
            if (entry.conversationId !== conversationId)
                continue;
            for (const passage of passagesOf(entry)) {
                const inserted = deps.db.insertItem({
                    conversationId,
                    owner: meta.owner ?? null,
                    kind: passage.kind,
                    entryId: passage.entryId,
                    messageIndex: passage.messageIndex,
                    offset: passage.offset,
                    length: passage.length,
                    artifact: null,
                    job: meta.jobId !== undefined,
                    cls: taintFrom !== undefined && passage.entryId >= taintFrom
                        ? "local-only"
                        : "normal",
                    at: passage.at,
                    title: meta.name ?? meta.autoName ?? null,
                }, redact(passage.text));
                if (inserted !== undefined)
                    indexed += 1;
            }
        }
        const lastEntry = page.items.at(-1);
        if (lastEntry !== undefined)
            deps.db.setCursor(conversationId, lastEntry.id);
        cursor = page.next;
    } while (cursor !== undefined);
    return { indexed };
}
