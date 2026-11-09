import type { ExtensionNoticeInput } from "@sigrun/sigrun/extension";
export declare const EMBEDDINGS_MOVED_KIND = "recall.embeddings-moved";
export declare const EMBEDDINGS_MOVED_TITLE = "Recall embeddings now come from a provider";
/**
 * The primary admin: the FIRST directory entry carrying the admin flag,
 * in directory order (core's own `primaryAdmin` rule). `undefined` for an
 * empty directory — single-operator mode, which core explicitly leaves
 * ownerless — and for a non-empty directory where nobody is an admin.
 * The two are NOT the same to the caller `src/index.ts`:
 *
 * - EMPTY directory -> the notice goes out USERLESS (`user: undefined`), the
 *   one shape core accepts without a recipient (`notifyExtension` demands a
 *   user only when the directory is claimed).
 * - Non-empty directory with no admin flag anywhere -> the notice is
 *   deliberately DROPPED: core would reject `undefined` there and there is
 *   no admin it is for (`sigrun user add` without `--admin`, proxy
 *   auto-provisioning and login-provisioned users all reach this).
 */
export declare function primaryAdmin(users: readonly {
    user: string;
    admin: boolean;
}[]): string | undefined;
/**
 * The one-per-boot "recall's own embeddings moved to a provider" notice.
 * Built from the RAW old settings: the `embedding` block is no longer
 * read for behaviour, only to tell the operator which model they had and
 * whether their existing vectors survived the migration.
 *
 * Silent when the block names no model: a `url`-only block never embedded
 * anything under a name worth reporting, and the v4 migration leaves its
 * rows unlabelled either way.
 */
export declare function embeddingsMovedNotice(raw: Record<string, unknown>): Pick<ExtensionNoticeInput, "kind" | "title" | "body"> | undefined;
