export interface Embedder {
    embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>;
    readonly local: boolean;
}
/** Call an [OI]-compatible embeddings endpoint without exposing a key by default. */
export declare function createEmbedder(cfg: {
    url: string;
    model: string;
    local: boolean;
}, apiKey: () => Promise<string | undefined>, fetchImpl?: typeof fetch): Embedder;
