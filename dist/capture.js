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
        const insertedForEmbedding = [];
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
                if (inserted !== undefined) {
                    indexed += 1;
                    insertedForEmbedding.push({
                        id: inserted,
                        text: redact(passage.text),
                        localOnly: taintFrom !== undefined && passage.entryId >= taintFrom,
                    });
                }
            }
        }
        if (deps.embedder !== undefined && deps.index !== undefined) {
            void embedPage(deps.embedder, deps.index, insertedForEmbedding);
        }
        const lastEntry = page.items.at(-1);
        if (lastEntry !== undefined)
            deps.db.setCursor(conversationId, lastEntry.id);
        cursor = page.next;
    } while (cursor !== undefined);
    return { indexed };
}
async function embedPage(embedder, index, inserted) {
    const candidates = inserted.filter(({ localOnly }) => !localOnly || embedder.local);
    for (let offset = 0; offset < candidates.length; offset += 64) {
        const batch = candidates.slice(offset, offset + 64);
        try {
            const vectors = await embedder.embed(batch.map(({ text }) => text));
            for (const [indexInBatch, vector] of vectors.entries()) {
                const candidate = batch[indexInBatch];
                if (candidate !== undefined)
                    index.upsert(candidate.id, vector);
            }
        }
        catch (error) {
            console.error("recall: passage embedding failed; item remains lexical-only", error);
        }
    }
}
