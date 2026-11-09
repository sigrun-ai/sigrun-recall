const DEFAULT_EXTERNALIZE_BYTES = 24_576;
const DEFAULT_EMBEDDING_TIMEOUT_MS = 800;
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
function nonEmptyString(value, setting) {
    if (typeof value === "string" && value !== "")
        return value;
    warnInvalid(setting);
    return undefined;
}
function embeddingSettings(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== "object" || Array.isArray(value)) {
        warnInvalid("embedding");
        return undefined;
    }
    const raw = value;
    const url = nonEmptyString(raw.url, "embedding.url");
    const model = nonEmptyString(raw.model, "embedding.model");
    if (url === undefined || model === undefined)
        return undefined;
    if (raw.local !== undefined && typeof raw.local !== "boolean") {
        warnInvalid("embedding.local");
    }
    return {
        url,
        model,
        local: typeof raw.local === "boolean" ? raw.local : false,
        timeoutMs: positiveInteger(raw.timeoutMs, DEFAULT_EMBEDDING_TIMEOUT_MS, "embedding.timeoutMs"),
    };
}
export async function resolveSettings(store) {
    const raw = await store.get();
    const settings = {
        externalizeBytes: positiveInteger(raw.externalizeBytes, DEFAULT_EXTERNALIZE_BYTES, "externalizeBytes"),
    };
    const embedding = embeddingSettings(raw.embedding);
    if (embedding !== undefined)
        settings.embedding = embedding;
    return settings;
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
    const embedding = raw.embedding;
    if (typeof embedding !== "object" || embedding === null)
        return undefined;
    const { url, model } = embedding;
    if (typeof url !== "string" || typeof model !== "string" || model === "")
        return undefined;
    let hostname;
    try {
        hostname = new URL(url).hostname;
    }
    catch {
        return undefined;
    }
    return hostname === "api.openai.com" ? `openai/${model}` : undefined;
}
/**
 * The model identity the legacy (pre-provider) embedder's vectors carry,
 * from the LIVE settings: the migration label where that rule applies
 * (`openai/<model>` against [OI]'s own endpoint, so an upgraded install
 * finds its inherited rows), else a host-qualified name no provider model
 * can collide with — two endpoints never share a vector space, even when
 * they serve the same model NAME.
 *
 * Task 9 replaces the legacy embedder with `host.embeddings`; this naming
 * only has to keep today's vectors honest until then.
 */
export function legacyEmbeddingModel(embedding) {
    const label = migrationLabel({ embedding });
    if (label !== undefined)
        return label;
    try {
        return `legacy/${new URL(embedding.url).hostname}/${embedding.model}`;
    }
    catch {
        return `legacy/${embedding.model}`;
    }
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
