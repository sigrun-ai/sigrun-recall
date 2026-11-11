import { audienceCovers } from "./audience.js";
import { passagesOf } from "./passages.js";
import { mayRead } from "./policy.js";
import { redact } from "./redact.js";
import { snippetOf } from "./snippet.js";
const ARM_LIMIT = 200;
const RRF_K = 60;
const DAY_MS = 86_400_000;
export function createSearcher(deps) {
    return {
        async search(query, ctx, limit) {
            if (limit <= 0)
                return [];
            const tokens = query.split(/\s+/).filter((token) => token.length >= 2);
            const porterQuery = tokens.map(quote).join(" ");
            const trigramQuery = tokens
                .filter((token) => token.length >= 3)
                .map(quote)
                .join(" ");
            const ranks = new Map();
            function fuse(rows) {
                for (const [index, row] of rows.entries()) {
                    const item = deps.db.item(row.id);
                    if (item === undefined)
                        continue;
                    const existing = ranks.get(row.id);
                    const score = 1 / (RRF_K + index + 1);
                    if (existing === undefined)
                        ranks.set(row.id, { item, score });
                    else
                        existing.score += score;
                }
            }
            if (porterQuery !== "")
                fuse(deps.db.searchPorter(porterQuery, ARM_LIMIT));
            if (trigramQuery !== "")
                fuse(deps.db.searchTrigram(trigramQuery, ARM_LIMIT));
            if (deps.vectors !== undefined) {
                const vectors = await deps.vectors.query(query, ARM_LIMIT);
                fuse(vectors.map(({ itemId }) => ({ id: itemId })));
            }
            const candidates = [...ranks.values()]
                .map((candidate) => ({
                ...candidate,
                score: candidate.score * recency(candidate.item.at, deps.now()),
            }))
                .sort((a, b) => b.score - a.score);
            const metas = new Map();
            const entries = new Map();
            const hits = [];
            for (const candidate of candidates) {
                if (hits.length >= limit)
                    break;
                const item = candidate.item;
                if (item.conversationId === ctx.excludeConversation ||
                    (item.job && !ctx.includeJobs) ||
                    (ctx.kinds !== undefined && !ctx.kinds.includes(item.kind)) ||
                    (ctx.since !== undefined && item.at < ctx.since) ||
                    (ctx.until !== undefined && item.at >= ctx.until)) {
                    continue;
                }
                let metaPromise;
                if (item.conversationId !== null) {
                    metaPromise = metas.get(item.conversationId);
                    if (metaPromise === undefined) {
                        metaPromise = deps.meta(item.conversationId).catch(() => undefined);
                        metas.set(item.conversationId, metaPromise);
                    }
                }
                else if (item.owner !== null) {
                    // User-owned documents have no conversation; the owner is the audience.
                    metaPromise = Promise.resolve({
                        pinned: false,
                        tagged: [],
                        archived: false,
                        draft: { text: "", attachments: [] },
                        source: "doc",
                        owner: item.owner,
                    });
                }
                const meta = metaPromise === undefined ? undefined : await metaPromise;
                if (meta === undefined ||
                    meta.internal === true ||
                    meta.deleted === true ||
                    !audienceCovers(ctx.current, meta)) {
                    continue;
                }
                if (!mayRead(item.cls, ctx.model, deps.isLocal))
                    continue;
                const source = await sourceText(deps, item, entries);
                if (source === undefined)
                    continue;
                const docRow = item.doc === null ? undefined : deps.db.doc(item.doc);
                hits.push({
                    item,
                    score: candidate.score,
                    snippet: snippetOf(redact(source), tokens),
                    handle: item.kind === "artifact"
                        ? item.artifact
                        : item.kind === "doc"
                            ? `d:${item.doc}`
                            : `r:${item.id}`,
                    conversationTitle: docRow === undefined
                        ? (meta.name ?? meta.autoName ?? null)
                        : docRow.title,
                });
            }
            return hits;
        },
    };
}
function quote(token) {
    return `"${token.replaceAll('"', '""')}"`;
}
function recency(at, now) {
    const ageDays = Math.max(0, (now - at) / DAY_MS);
    return 0.8 + 0.2 * Math.exp(-ageDays / 180);
}
async function sourceText(deps, item, entries) {
    if (item.kind === "artifact") {
        // Artifact snippets read the stored whole text (Task 5's store);
        // recall_open reuses the same read.
        return item.artifact === null
            ? undefined
            : deps.artifactStore?.read(item.artifact, item.offset, item.length);
    }
    if (item.kind === "doc") {
        return item.doc === null
            ? undefined
            : deps.db.docText(item.doc, item.offset, item.length);
    }
    if (item.entryId === null || item.messageIndex === null)
        return undefined;
    const key = `${item.conversationId}:${item.entryId}`;
    let entryPromise = entries.get(key);
    if (entryPromise === undefined) {
        const conversationId = item.conversationId;
        const entryId = item.entryId;
        if (conversationId === null)
            return undefined;
        entryPromise = deps.entry(conversationId, entryId);
        entries.set(key, entryPromise);
    }
    const entry = await entryPromise;
    if (entry === undefined)
        return undefined;
    const passage = passagesOf(entry).find((candidate) => candidate.messageIndex === item.messageIndex &&
        candidate.blockIndex === item.blockIndex &&
        candidate.offset === item.offset);
    return passage?.text;
}
