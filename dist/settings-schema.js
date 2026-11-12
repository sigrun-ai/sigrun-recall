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
import { Type } from "typebox";
/**
 * Widen a TypeBox schema to the host's structural JSON-Schema contract
 * (`SettingsJsonSchema = Readonly<Record<string, unknown>>`): TypeBox's
 * TObject carries no string index signature, but every schema it builds
 * IS a plain JSON object. The `Static` type stays on the original.
 */
function asJsonSchema(schema) {
    return schema;
}
/** The shipped threshold, 24 KiB — the deleted parser's fallback. */
export const DEFAULT_EXTERNALIZE_BYTES = 24_576;
export const RECALL_SETTINGS_SCHEMA = asJsonSchema(Type.Object({
    externalizeBytes: Type.Integer({
        title: "Externalize bytes",
        description: "Complete tool results larger than this are stored whole under artifacts/ and replaced in model output by a head, outline and handle. Truncated or spilled output is never externalized.",
        // The old parser honoured any INTEGER above zero and fell back to
        // 24576 for everything else, so the bound is the same `> 0`.
        minimum: 1,
        default: DEFAULT_EXTERNALIZE_BYTES,
        // Read per afterTool call.
        "x-sigrun-apply": "live",
    }),
}));
export const RECALL_USER_SETTINGS_SCHEMA = asJsonSchema(Type.Object({
    autoRecall: Type.Boolean({
        title: "Automatic recall",
        description: "Add bounded, clearly marked reference material from your past conversations to each new user message. The current conversation and job runs are always excluded.",
        default: true,
        // Read per request.
        "x-sigrun-apply": "live",
    }),
}));
