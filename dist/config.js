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
