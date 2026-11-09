export interface SettingsReader {
    get(): Promise<Record<string, unknown>>;
}
export interface RecallSettings {
    externalizeBytes: number;
    embedding?: {
        url: string;
        model: string;
        local: boolean;
        timeoutMs: number;
    };
}
export interface UserRecallSettings {
    autoRecall: boolean;
    localProviders: readonly string[];
}
export declare function resolveSettings(store: SettingsReader): Promise<RecallSettings>;
/**
 * The model label the v4 vector migration stamps on existing rows, from
 * the RAW old settings: `openai/<embedding.model>` only when the old
 * settings named a model AND pointed at [OI]'s own endpoint. Any other
 * endpoint might have served a different model under that name — the
 * silent mismatch the model-keyed vectors exist to forbid — so those
 * rows stay unlabelled (`model = ""`, which never matches a real model)
 * and are re-embedded.
 */
export declare function migrationLabel(raw: Record<string, unknown>): string | undefined;
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
export declare function legacyEmbeddingModel(embedding: {
    url: string;
    model: string;
}): string;
export declare function resolveUserSettings(store: SettingsReader): Promise<UserRecallSettings>;
