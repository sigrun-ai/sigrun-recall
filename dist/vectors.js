import { passagesOf } from "./passages.js";
import { redact } from "./redact.js";
/** Store vectors in SQLite and scan bounded pages for cosine nearest neighbours. */
export function createSqliteVectorIndex(db, pageSize = 2000) {
    return {
        upsert(itemId, vec) {
            db.upsertVector(itemId, vec);
        },
        query(vec, k, signal) {
            if (k <= 0)
                return [];
            const best = [];
            let after = 0;
            for (let page = 0; page < 50; page += 1) {
                if (signal?.aborted === true)
                    break;
                const rows = db.listVectorsPage(after, pageSize);
                for (const row of rows) {
                    const score = cosine(vec, row.vec);
                    best.push({ itemId: row.itemId, score });
                    best.sort((a, b) => b.score - a.score);
                    if (best.length > k)
                        best.pop();
                }
                if (rows.length < pageSize)
                    break;
                after = rows.at(-1).itemId;
            }
            return best;
        },
    };
}
function cosine(left, right) {
    const rightVector = new Float32Array(right.buffer.slice(right.byteOffset, right.byteOffset + right.byteLength));
    if (left.length !== rightVector.length)
        return -1;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
        dot += left[index] * rightVector[index];
        leftNorm += left[index] ** 2;
        rightNorm += rightVector[index] ** 2;
    }
    if (leftNorm === 0 || rightNorm === 0)
        return 0;
    return dot / Math.sqrt(leftNorm * rightNorm);
}
/** Embed up to `limit` unembedded conversation passages from their source entries. */
export async function embedPending(db, embedder, index, entry, limit = 500) {
    const candidates = [];
    for (const item of db.listUnembeddedItems(limit, embedder.local)) {
        if (item.kind === "doc") {
            if (item.doc === null)
                continue;
            const text = db.docText(item.doc, item.offset, item.length);
            if (text !== undefined)
                candidates.push({ id: item.id, text });
            continue;
        }
        if (item.entryId === null ||
            item.messageIndex === null ||
            item.conversationId === null) {
            continue;
        }
        const record = await entry(item.conversationId, item.entryId);
        if (record === undefined)
            continue;
        const passage = passagesOf(record).find((candidate) => candidate.messageIndex === item.messageIndex &&
            candidate.blockIndex === item.blockIndex &&
            candidate.offset === item.offset);
        if (passage !== undefined)
            candidates.push({ id: item.id, text: redact(passage.text) });
    }
    for (let offset = 0; offset < candidates.length; offset += 64) {
        const batch = candidates.slice(offset, offset + 64);
        try {
            const vectors = await embedder.embed(batch.map(({ text }) => text));
            for (const [position, vector] of vectors.entries()) {
                const candidate = batch[position];
                if (candidate !== undefined)
                    index.upsert(candidate.id, vector);
            }
        }
        catch (error) {
            console.error("recall: pending passage embedding failed", error);
        }
    }
}
/** Add a semantic arm that degrades to lexical search on embedding failure. */
export function createVectorArm(embedder, index, timeoutMs) {
    let lastWarning = -Infinity;
    return {
        async query(text, candidateLimit) {
            const signal = AbortSignal.timeout(timeoutMs);
            try {
                const vectors = await embedder.embed([text], signal);
                const vector = vectors[0];
                if (vector === undefined)
                    return [];
                return index.query(vector, candidateLimit, signal).map(({ itemId, score }) => ({
                    itemId,
                    rank: score,
                }));
            }
            catch (error) {
                const now = Date.now();
                if (now - lastWarning >= 60_000) {
                    console.warn("recall: semantic search unavailable; using lexical results", error);
                    lastWarning = now;
                }
                return [];
            }
        },
    };
}
