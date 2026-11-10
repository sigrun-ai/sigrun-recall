/**
 * The dead pre-provider `embedding` settings group, read off the RAW stored
 * settings file.
 *
 * This is not part of recall's declared settings (`src/settings-schema.ts`
 * omits the group on purpose — embeddings come from `host.embeddings`), so
 * these helpers deliberately bypass the declared handle: the handle checks
 * and repairs values, while the migration needs what the operator actually
 * wrote. Two consumers, both migration-only: the v4 vector label stamped
 * before the database is first opened, and the one-per-boot "embeddings
 * moved to a provider" notice.
 */
/**
 * The model the OLD (pre-provider) `embedding` settings block named, if it
 * is still on disk.
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
