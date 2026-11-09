const DEFAULT_EXTERNALIZE_BYTES = 24_576;
function warnInvalid(setting) {
    console.warn(`recall: invalid ${setting} setting; using its default`);
}
function positiveInteger(value, fallback, setting) {
    if (value === undefined)
        return fallback;
    if (typeof value === "number" && Number.isInteger(value) && value > 0)
        return value;
    warnInvalid(setting);
    return fallback;
}
export async function resolveSettings(store) {
    const raw = await store.get();
    return {
        externalizeBytes: positiveInteger(raw.externalizeBytes, DEFAULT_EXTERNALIZE_BYTES, "externalizeBytes"),
    };
}
/**
 * The model the OLD (pre-provider) `embedding` settings block named, if it
 * is still on disk. Recall no longer reads that block for anything except
 * two migration concerns: the v4 vector label (below) and the
 * one-per-boot "embeddings moved to a provider" notice.
 */
export function legacyEmbeddingSettings(raw) {
    const embedding = raw.embedding;
    if (typeof embedding !== "object" || embedding === null)
        return undefined;
    const { url, model } = embedding;
    if (typeof url !== "string" || typeof model !== "string")
        return undefined;
    if (model === "")
        return undefined;
    return { url, model };
}
/**
 * The model label the v4 vector migration stamps on existing rows, from
 * the RAW old settings: `openai/<embedding.model>` only when the old
 * settings named a model AND pointed at [OI]'s own endpoint. Any other
 * endpoint might have served a different model under that name — the
 * silent mismatch the model-keyed vectors exist to forbid — so those
 * rows stay unlabelled (`model = ""`, which never matches a real model)
 * and are re-embedded.
 */
export function migrationLabel(raw) {
    const legacy = legacyEmbeddingSettings(raw);
    if (legacy === undefined)
        return undefined;
    let hostname;
    try {
        hostname = new URL(legacy.url).hostname;
    }
    catch {
        return undefined;
    }
    return hostname === "api.openai.com" ? `openai/${legacy.model}` : undefined;
}
export async function resolveUserSettings(store) {
    const raw = await store.get();
    if (raw.autoRecall !== undefined && typeof raw.autoRecall !== "boolean") {
        warnInvalid("autoRecall");
    }
    let localProviders = [];
    if (raw.localProviders !== undefined) {
        if (Array.isArray(raw.localProviders) &&
            raw.localProviders.every((provider) => typeof provider === "string" && provider !== "")) {
            localProviders = [...raw.localProviders];
        }
        else {
            warnInvalid("localProviders");
        }
    }
    return {
        autoRecall: typeof raw.autoRecall === "boolean" ? raw.autoRecall : true,
        localProviders,
    };
}
