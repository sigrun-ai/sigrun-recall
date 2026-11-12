import { passagesOf } from "../passages.js";
const DEFAULT_PAGE_SIZE = 200;
export function createLineageMemo() {
    return new Map();
}
/** Derive each inherited conversation's fork point from the raw entries. */
export async function loadLineage(conversationId, read, options = {}) {
    const memo = options.memo ?? createLineageMemo();
    let lineage = memo.get(conversationId);
    if (lineage === undefined) {
        lineage = readLineage(conversationId, read, options.pageSize ?? DEFAULT_PAGE_SIZE);
        memo.set(conversationId, lineage);
        lineage.catch(() => memo.delete(conversationId));
    }
    return lineage;
}
async function readLineage(conversationId, read, pageSize) {
    const inherited = new Map();
    let cursor;
    do {
        const page = await read({ order: "ascending" }, pageSize, cursor);
        for (const entry of page.items) {
            if (entry.conversationId === conversationId) {
                return [
                    ...inherited.values(),
                    {
                        conversationId,
                        throughEntryId: Number.POSITIVE_INFINITY,
                        throughAt: Number.POSITIVE_INFINITY,
                    },
                ];
            }
            const prior = inherited.get(entry.conversationId)?.throughAt ?? 0;
            const throughAt = passagesOf(entry).reduce((latest, passage) => Math.max(latest, passage.at), prior);
            inherited.set(entry.conversationId, {
                conversationId: entry.conversationId,
                throughEntryId: entry.id,
                throughAt,
            });
        }
        cursor = page.next;
    } while (cursor !== undefined);
    return [
        ...inherited.values(),
        {
            conversationId,
            throughEntryId: Number.POSITIVE_INFINITY,
            throughAt: Number.POSITIVE_INFINITY,
        },
    ];
}
/** Whether an indexed item is already visible in the request's model context. */
export function inContext(item, rule) {
    const link = rule.lineage.find((candidate) => candidate.conversationId === item.conversationId);
    if (link === undefined)
        return false;
    if (item.entryId !== null) {
        if (item.entryId > link.throughEntryId)
            return false;
        return rule.boundary === undefined || item.entryId >= rule.boundary.entryId;
    }
    if (item.at > link.throughAt)
        return false;
    return rule.boundary === undefined || item.at >= rule.boundary.at;
}
