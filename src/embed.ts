export interface Embedder {
	embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>;
	readonly local: boolean;
}

/** Call an [OI]-compatible embeddings endpoint without exposing a key by default. */
export function createEmbedder(
	cfg: { url: string; model: string; local: boolean },
	apiKey: () => Promise<string | undefined>,
	fetchImpl: typeof fetch = fetch,
): Embedder {
	return {
		local: cfg.local,
		async embed(texts, signal) {
			const key = await apiKey();
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (typeof key === "string" && key !== "") headers.authorization = `Bearer ${key}`;
			const response = await fetchImpl(`${cfg.url}/embeddings`, {
				method: "POST",
				headers,
				body: JSON.stringify({ model: cfg.model, input: texts }),
				signal,
			});
			if (!response.ok) throw new Error(`embedding endpoint returned ${response.status}`);
			const body = (await response.json()) as {
				data: { embedding: number[] }[];
			};
			return body.data.map(({ embedding }) => new Float32Array(embedding));
		},
	};
}
