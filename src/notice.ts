import type { ExtensionNoticeInput } from "@sigrun/sigrun/extension";

import { legacyEmbeddingSettings, migrationLabel } from "./config.js";

export const EMBEDDINGS_MOVED_KIND = "recall.embeddings-moved";
export const EMBEDDINGS_MOVED_TITLE = "Recall embeddings now come from a provider";

/** The `host.users` / `host.notify` slice the migration notice needs. */
export interface NoticeHost {
	users: { list(): Promise<readonly { user: string; admin: boolean }[]> };
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
export function primaryAdmin(
	users: readonly { user: string; admin: boolean }[],
): string | undefined {
	return users.find((entry) => entry.admin === true)?.user;
}

/**
 * The one-per-boot "recall's own embeddings moved to a provider" notice.
 * Built from the RAW old settings: the `embedding` block is no longer
 * read for behaviour, only to tell the operator which model they had and
 * whether their existing vectors survived the migration.
 */
export function embeddingsMovedNotice(
	raw: Record<string, unknown>,
): Pick<ExtensionNoticeInput, "kind" | "title" | "body"> | undefined {
	const legacy = legacyEmbeddingSettings(raw);
	if (legacy === undefined) return undefined;
	const label = migrationLabel(raw);
	const kept =
		label === undefined
			? [
					`Existing vectors will be re-embedded: the old endpoint (${legacy.url}) could have served a different model under the name "${legacy.model}", so those rows stay unlabelled and the background sweep re-embeds them under the new model.`,
				]
			: [
					`Existing vectors were kept: they are labelled "${label}", so setting \`embeddingModel\` to that model reuses them without re-embedding anything.`,
				];
	const body = [
		`Recall used to embed through its own \`embedding\` setting, with the model "${legacy.model}". That block no longer does anything.`,
		...kept,
		`Embeddings now come from a provider. Set \`embeddingModel\` (for example \`openai/text-embedding-3-small\`) and give that provider an OpenAI credential — either in auth.json under \`openai\`, or in the \`OPENAI_API_KEY\` environment variable — then delete recall's old \`embedding\` block. Until a model is set, recall searches lexically only.`,
	].join(" ");
	return {
		kind: EMBEDDINGS_MOVED_KIND,
		title: EMBEDDINGS_MOVED_TITLE,
		body,
	};
}
