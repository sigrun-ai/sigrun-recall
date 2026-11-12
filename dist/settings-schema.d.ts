/**
 * Recall's declared settings (settings rework): the shared
 * `externalizeBytes` key and the per-user `autoRecall` setting, as JSON
 * Schema. Core generates the settings page from this file
 * and checks every save against it, so the schema is the single source of
 * the defaults and of the malformed-value repair that the deleted
 * `resolveSettings`/`resolveUserSettings` parsers performed by hand.
 *
 * Two schemas, matching who reads the key:
 *
 * - **shared** (`settings/recall.json`) — `externalizeBytes`, the size at
 *   which a complete tool result is stored whole and replaced in model
 *   output by a head, outline and handle.
 * - **per user** — `autoRecall`, which decides whether one directory
 *   user's requests are augmented. Locality comes from the admin's
 *   provider switches through `host.models.isLocal`, never from a user
 *   settings key.
 *
 * The OLD `embedding` group is deliberately NOT declared: embeddings come
 * from core's registry (`host.embeddings`), so a model, endpoint, locality
 * flag or timeout in a settings file cannot affect anything. A stored
 * `embedding` key therefore survives as an unknown key (the Advanced pane
 * lists it), and `legacy-embedding.ts` reads it off the raw file for
 * two migration concerns only.
 */
import { Type, type Static } from "typebox";
/** The shipped threshold, 24 KiB — the deleted parser's fallback. */
export declare const DEFAULT_EXTERNALIZE_BYTES = 24576;
export declare const RECALL_SETTINGS_SCHEMA: Type.TObject<{
    externalizeBytes: Type.TInteger;
    sittings: Type.TObject<{
        minGapMinutes: Type.TInteger;
        minHistoryTokens: Type.TInteger;
    }>;
}> & Readonly<Record<string, unknown>>;
export declare const RECALL_USER_SETTINGS_SCHEMA: Type.TObject<{
    autoRecall: Type.TBoolean;
    sittings: Type.TBoolean;
}> & Readonly<Record<string, unknown>>;
export type RecallSettings = Static<typeof RECALL_SETTINGS_SCHEMA>;
export type UserRecallSettings = Static<typeof RECALL_USER_SETTINGS_SCHEMA>;
