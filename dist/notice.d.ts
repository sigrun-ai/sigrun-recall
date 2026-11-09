import type { ExtensionNoticeInput } from "@sigrun/sigrun/extension";
export declare const EMBEDDINGS_MOVED_KIND = "recall.embeddings-moved";
export declare const EMBEDDINGS_MOVED_TITLE = "Recall embeddings now come from a provider";
/** The `host.users` / `host.notify` slice the migration notice needs. */
export interface NoticeHost {
    users: {
        list(): Promise<readonly {
            user: string;
            admin: boolean;
        }[]>;
    };
    notify(input: ExtensionNoticeInput): Promise<void>;
}
/**
 * The primary admin: the FIRST directory entry carrying the admin flag,
 * in directory order. Core does not accept `undefined` as a recipient on
 * a claimed server (`src/server/notifications.ts`: "notification user is
 * required when the directory is non-empty"), so `undefined` is only
 * ever right for an empty directory. A directory with users but no
 * admin returns `undefined` too, and the caller skips the notice — there
 * is nobody the notice is FOR.
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
 */
export declare function embeddingsMovedNotice(raw: Record<string, unknown>): Pick<ExtensionNoticeInput, "kind" | "title" | "body"> | undefined;
