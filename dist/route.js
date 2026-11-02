export function createRoutes(deps) {
    return [
        {
            method: "GET",
            path: "search",
            auth: "user",
            async handler(request, ctx) {
                if (ctx.principal?.user === undefined) {
                    return Response.json({ error: "user required" }, { status: 401 });
                }
                const url = new URL(request.url);
                const requested = Number(url.searchParams.get("limit") ?? 20);
                const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.trunc(requested))) : 20;
                const hits = await deps.searcher.search(url.searchParams.get("q") ?? "", {
                    current: { conversationId: undefined, owner: ctx.principal.user },
                    model: undefined,
                    includeJobs: true,
                }, limit);
                return Response.json({
                    hits: hits.map((hit) => ({
                        handle: hit.handle,
                        conversationId: hit.item.conversationId,
                        title: hit.conversationTitle,
                        at: hit.item.at,
                        snippet: hit.snippet,
                        score: hit.score,
                    })),
                });
            },
        },
        {
            method: "POST",
            path: "backfill",
            auth: "admin",
            async handler(_request, ctx) {
                if (ctx.principal?.admin !== true) {
                    return Response.json({ error: "admin required" }, { status: 403 });
                }
                return Response.json(await deps.sweep());
            },
        },
    ];
}
