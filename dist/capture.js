import { passagesOf } from "./passages.js";
import { redact } from "./redact.js";
import { DEFAULT_EMBEDDING_WARNINGS, embedClass } from "./vectors.js";
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
        const normal = [];
        const local = [];
        for (const entry of page.items) {
            if (entry.conversationId !== conversationId)
                continue;
            for (const passage of passagesOf(entry)) {
                const localOnly = taintFrom !== undefined && passage.entryId >= taintFrom;
                const inserted = deps.db.insertItem({
                    conversationId,
                    owner: meta.owner ?? null,
                    kind: passage.kind,
                    entryId: passage.entryId,
                    messageIndex: passage.messageIndex,
                    blockIndex: passage.blockIndex,
                    offset: passage.offset,
                    length: passage.length,
                    artifact: null,
                    doc: null,
                    job: meta.jobId !== undefined,
                    cls: localOnly ? "local-only" : "normal",
                    at: passage.at,
                    title: meta.name ?? meta.autoName ?? null,
                }, redact(passage.text));
                if (inserted !== undefined) {
                    indexed += 1;
                    (localOnly ? local : normal).push({
                        id: inserted,
                        text: redact(passage.text),
                    });
                }
            }
        }
        if (deps.embeddings !== undefined) {
            const work = embedPage(deps, normal, local);
            if (deps.trackEmbedding === undefined)
                void work;
            else
                deps.trackEmbedding(work);
        }
        const lastEntry = page.items.at(-1);
        if (lastEntry !== undefined)
            deps.db.setCursor(conversationId, lastEntry.id);
        cursor = page.next;
    } while (cursor !== undefined);
    return { indexed };
}
/**
 * TWO calls per page, one per confidentiality class — never mixed, so a
 * provider that refuses `local-only` cannot take the normal batch down with
 * it (and the normal batch is never labelled more strictly than it needs to
 * be). No `model` is requested: the live `embeddingModel` default decides.
 */
async function embedPage(deps, normal, local) {
    const embeddings = deps.embeddings;
    if (embeddings === undefined)
        return;
    const warn = deps.warn ?? DEFAULT_EMBEDDING_WARNINGS;
    const upsert = (itemId, model, vec) => deps.db.upsertVector(itemId, model, vec);
    // Containment: `embed` is contracted never to throw, but this promise is
    // fire-and-forget (nobody awaits a capture's embedding), so a throw from
    // a host that breaks the contract — a bridge that never bound, a closed
    // database after shutdown — must be logged here, NOT left to become an
    // unhandled rejection. The items stay lexical-only either way.
    for (const [batch, confidentiality] of [
        [normal, "normal"],
        [local, "local-only"],
    ]) {
        try {
            await embedClass(embeddings, upsert, batch, confidentiality, undefined, warn);
        }
        catch (error) {
            warn("failed", `passage embedding failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }
    }
}
