import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { audienceCovers } from "./audience.js";
import { mayRead } from "./policy.js";
const OPEN_LIMIT = 16_384;
function output(text) {
    return { output: [{ type: "text", text }] };
}
function date(value) {
    if (value === undefined)
        return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}
function taint(db, conversationId, item) {
    if (item.cls === "local-only") {
        db.setTaint(conversationId, (db.cursor(conversationId) ?? 0) + 1);
    }
}
async function permitted(deps, current, item, provider) {
    if (!audienceCovers(current, { owner: item.owner ?? undefined }))
        return undefined;
    const meta = await deps.meta(item.conversationId).catch(() => undefined);
    if (meta === undefined || meta.internal === true || !audienceCovers(current, meta)) {
        return undefined;
    }
    const providers = item.owner === null ? [] : await deps.localProviders(item.owner).catch(() => []);
    if (!mayRead(item.cls, provider === undefined ? undefined : { provider }, providers)) {
        return undefined;
    }
    return meta;
}
function renderEntries(entries) {
    const lines = [];
    for (const entry of entries) {
        for (const message of entry.model ?? []) {
            if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") {
                continue;
            }
            const text = typeof message.content === "string"
                ? message.content
                : message.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n");
            if (text !== "")
                lines.push(`${message.role}: ${text}`);
        }
    }
    let bytes = 0;
    const bounded = [];
    for (const line of lines) {
        if (bytes >= OPEN_LIMIT)
            break;
        const remaining = OPEN_LIMIT - bytes;
        const buffer = Buffer.from(line, "utf8");
        bounded.push(buffer.subarray(0, remaining).toString("utf8"));
        bytes += Math.min(buffer.length, remaining);
    }
    return bounded.join("\n");
}
/** Build the read-only model-facing recall tools. */
export function createTools(deps) {
    const search = defineTool({
        name: "recall_search",
        description: "Search past conversations and stored tool results for relevant material.",
        parameters: Type.Object({
            query: Type.String(),
            since: Type.Optional(Type.String()),
            until: Type.Optional(Type.String()),
            kind: Type.Optional(Type.Union([Type.Literal("conversation"), Type.Literal("page")])),
            conversation: Type.Optional(Type.Number()),
        }),
        replay: "safe",
        async execute(args, api, context) {
            const conversationId = Number(api.conversationId);
            const current = await deps.meta(conversationId);
            const model = (await api.agent(context)).model;
            const kinds = args.kind === "conversation"
                ? ["turn", "tool"]
                : args.kind === "page"
                    ? ["artifact"]
                    : undefined;
            const hits = await deps.searcher.search(args.query, {
                current: {
                    conversationId,
                    owner: current.owner,
                    sharing: current.sharing,
                },
                model: model === undefined ? undefined : { provider: model.provider },
                includeJobs: true,
                since: date(args.since),
                until: date(args.until),
                kinds,
            }, args.conversation === undefined ? 10 : 200);
            const selected = hits
                .filter((hit) => args.conversation === undefined || hit.item.conversationId === args.conversation)
                .slice(0, 10);
            for (const hit of selected)
                taint(deps.db, conversationId, hit.item);
            if (selected.length === 0)
                return output("No matching past material.");
            // Stable score order within first-seen conversation groups.
            const groups = new Map();
            for (const hit of selected) {
                const group = groups.get(hit.item.conversationId) ?? [];
                group.push(hit);
                groups.set(hit.item.conversationId, group);
            }
            const lines = [...groups.values()].flatMap((group) => group.map((hit) => {
                const day = new Date(hit.item.at).toISOString().slice(0, 10);
                const title = hit.conversationTitle ?? `conversation ${hit.item.conversationId}`;
                return `[${day}] ${title} — ${hit.snippet} (${hit.handle})`;
            }));
            return output(lines.join("\n"));
        },
    });
    const open = defineTool({
        name: "recall_open",
        description: "Open a recalled passage or read a slice of a stored artifact.",
        parameters: Type.Object({
            handle: Type.String(),
            offset: Type.Optional(Type.Number()),
            length: Type.Optional(Type.Number({ maximum: OPEN_LIMIT })),
        }),
        replay: "safe",
        async execute(args, api, context) {
            const conversationId = Number(api.conversationId);
            const current = await deps.meta(conversationId);
            const model = (await api.agent(context)).model;
            const provider = model?.provider;
            const item = await itemForHandle(deps.db, args.handle);
            if (item === undefined || (await permitted(deps, current, item, provider)) === undefined) {
                return output("Not available here.");
            }
            taint(deps.db, conversationId, item);
            if (args.handle.startsWith("a:")) {
                const length = Math.min(args.length ?? OPEN_LIMIT, OPEN_LIMIT);
                const text = deps.artifactStore.read(args.handle, args.offset ?? 0, length);
                return text === undefined ? output("Not available here.") : output(text);
            }
            if (item.entryId === null)
                return output("Not available here.");
            const page = await deps
                .entries(item.conversationId, {
                minEntryId: Math.max(1, item.entryId - 3),
                maxEntryId: item.entryId + 3,
                order: "ascending",
            }, 10, undefined)
                .catch(() => undefined);
            if (page === undefined)
                return output("Not available here.");
            const text = renderEntries(page.items);
            return output(text === "" ? "Not available here." : text);
        },
    });
    return [search, open];
}
async function itemForHandle(db, handle) {
    if (handle.startsWith("r:"))
        return db.item(Number(handle.slice(2)));
    if (handle.startsWith("a:"))
        return db.itemByArtifact(handle);
    return undefined;
}
