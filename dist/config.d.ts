export interface SettingsReader {
    get(): Promise<Record<string, unknown>>;
}
export interface RecallSettings {
    externalizeBytes: number;
}
export interface UserRecallSettings {
    autoRecall: boolean;
    localProviders: readonly string[];
}
export declare function resolveSettings(store: SettingsReader): Promise<RecallSettings>;
/**
 * The model the OLD (pre-provider) `embedding` settings block named, if it
 * is still on disk. Recall no longer reads that block for anything except
 * two migration concerns: the v4 vector label (below) and the
 * one-per-boot "embeddings moved to a provider" notice.
 */
export declare function legacyEmbeddingSettings(raw: Record<string, unknown>): {
    url: string;
    model: string;
} | undefined;
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
export declare function resolveUserSettings(store: SettingsReader): Promise<UserRecallSettings>;
