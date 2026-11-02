/** Call an [OI]-compatible embeddings endpoint without exposing a key by default. */
export function createEmbedder(cfg, apiKey, fetchImpl = fetch) {
    return {
        local: cfg.local,
        async embed(texts, signal) {
            const key = await apiKey();
            const headers = { "content-type": "application/json" };
            if (typeof key === "string" && key !== "")
                headers.authorization = `Bearer ${key}`;
            const response = await fetchImpl(`${cfg.url}/embeddings`, {
                method: "POST",
                headers,
                body: JSON.stringify({ model: cfg.model, input: texts }),
                signal,
            });
            if (!response.ok)
                throw new Error(`embedding endpoint returned ${response.status}`);
            const body = (await response.json());
            return body.data.map(({ embedding }) => new Float32Array(embedding));
        },
    };
}
