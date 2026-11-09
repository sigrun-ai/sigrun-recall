import { passagesOf } from "./passages.js";
import { redact } from "./redact.js";
/**
 * A per-code warning throttle: a misconfigured provider fails every page
 * and every query, so a per-call log would drown the operator. Each code
 * speaks at most once a minute — long enough to stay quiet, short enough
 * that a transient `failed` cannot go silent for the whole process.
 *
 * `not_local` and `no_model` are expected states (local-only material on a
 * shared model; embeddings simply not configured) and never warn: the
 * items remain lexical, which is the documented behaviour.
 */
export function createEmbeddingWarnings(now = Date.now, windowMs = 60_000) {
    const last = new Map();
    return (code, message) => {
        if (code === "not_local" || code === "no_model")
            return;
        const at = now();
        const previous = last.get(code);
        if (previous !== undefined && at - previous < windowMs)
            return;
        last.set(code, at);
        console.warn(`recall: embeddings ${code}; ${message}`);
    };
}
/**
 * The process-wide throttle a caller gets when it does not inject one, so
 * library users and the capture page share ONE budget per code instead of
 * starting a fresh one per call.
 */
export const DEFAULT_EMBEDDING_WARNINGS = createEmbeddingWarnings();
/** Store vectors in SQLite and scan bounded pages for cosine nearest neighbours. */
export function createSqliteVectorIndex(db, model, pageSize = 2000) {
    return {
        upsert(itemId, vec) {
            db.upsertVector(itemId, model, vec);
        },
        query(vec, k, signal) {
            if (k <= 0)
                return [];
            const best = [];
            let after = 0;
            for (let page = 0; page < 50; page += 1) {
                if (signal?.aborted === true)
                    break;
                const rows = db.listVectorsPage(model, after, pageSize);
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
/**
 * One embedding call for one confidentiality class. `host.embeddings.embed`
 * never throws and splits above the provider's batch size itself, so a page
 * needs exactly one call per class, not a recall-side chunker.
 *
 * `confidentiality: "local-only"` with a model core does not trust for local
 * material comes back `not_local`; the whole batch then stays lexical rather
 * than leaking, which is the documented outcome. Vectors are stored under the
 * model the provider RETURNED, never a recall-side guess.
 */
export async function embedClass(embeddings, upsert, batch, confidentiality, model, warn) {
    if (batch.length === 0)
        return;
    const opts = {
        confidentiality,
    };
    if (model !== undefined)
        opts.model = model;
    const result = await embeddings.embed(batch.map(({ text }) => text), opts);
    if (!result.ok) {
        warn(result.code, result.message);
        return;
    }
    for (const [position, vector] of result.vectors.entries()) {
        const candidate = batch[position];
        if (candidate !== undefined)
            upsert(candidate.id, result.model, vector);
    }
}
/**
 * Embed up to `limit` unembedded conversation passages from their source
 * entries. Local-only items ride `includeLocalOnly` (a model core trusts
 * for local material) and are submitted with `confidentiality:
 * "local-only"`; the rest go as `normal`.
 */
export async function embedPending(db, embeddings, model, modelIsLocal, entry, limit = 500, warn = DEFAULT_EMBEDDING_WARNINGS) {
    const normal = [];
    const local = [];
    for (const item of db.listUnembeddedItems(model, limit, modelIsLocal)) {
        const target = item.cls === "local-only" ? local : normal;
        if (item.kind === "doc") {
            if (item.doc === null)
                continue;
            const text = db.docText(item.doc, item.offset, item.length);
            if (text !== undefined)
                target.push({ id: item.id, text });
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
            target.push({ id: item.id, text: redact(passage.text) });
    }
    const upsert = (itemId, storedModel, vec) => db.upsertVector(itemId, storedModel, vec);
    // Same containment as the capture page: the sweep is awaited by a job
    // phase, and a throwing host must leave the remaining items pending for
    // the next pass rather than fail the phase.
    for (const [batch, confidentiality] of [
        [normal, "normal"],
        [local, "local-only"],
    ]) {
        try {
            await embedClass(embeddings, upsert, batch, confidentiality, model, warn);
        }
        catch (error) {
            warn("failed", `pending passage embedding failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }
    }
}
/**
 * Add a semantic arm over `model`'s index. The QUERY is embedded with
 * that same model — the index is model-scoped, so a query embedded by a
 * different model would compare vectors from two spaces. Failures
 * degrade to lexical search (the vector arm simply contributes nothing).
 */
export function createVectorArm(embeddings, index, model, timeoutMs, warn = DEFAULT_EMBEDDING_WARNINGS) {
    return {
        async query(text, candidateLimit) {
            const signal = AbortSignal.timeout(timeoutMs);
            try {
                const result = await embeddings.embed([text], {
                    model,
                    timeoutMs,
                    signal,
                });
                if (!result.ok) {
                    warn(result.code, result.message);
                    return [];
                }
                const vector = result.vectors[0];
                if (vector === undefined)
                    return [];
                return index.query(vector, candidateLimit, signal).map(({ itemId, score }) => ({
                    itemId,
                    rank: score,
                }));
            }
            catch (error) {
                warn("failed", error instanceof Error ? error.message : "semantic search unavailable");
                return [];
            }
        },
    };
}
