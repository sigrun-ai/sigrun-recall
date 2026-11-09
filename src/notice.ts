import type { ExtensionNoticeInput } from "@sigrun/sigrun/extension";

import { legacyEmbeddingSettings, migrationLabel } from "./config.js";

export const EMBEDDINGS_MOVED_KIND = "recall.embeddings-moved";
export const EMBEDDINGS_MOVED_TITLE = "Recall embeddings now come from a provider";

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
 *
 * Silent when the block names no model: a `url`-only block never embedded
 * anything under a name worth reporting, and the v4 migration leaves its
 * rows unlabelled either way.
 */
export function embeddingsMovedNotice(
	raw: Record<string, unknown>,
): Pick<ExtensionNoticeInput, "kind" | "title" | "body"> | undefined {
	const legacy = legacyEmbeddingSettings(raw);
	if (legacy === undefined) return undefined;
	const label = migrationLabel(raw)?.slice(0, 200);
	// Model, label and endpoint come from operator config, so bound them: the body
	// cap is 2000 characters and `notify` REJECTS anything longer, which
	// would lose the notice entirely.
	const model = legacy.model.slice(0, 200);
	const endpoint = legacy.url.slice(0, 300);
	const kept =
		label === undefined
			? [
					`Existing vectors will be re-embedded: the old endpoint (${endpoint}) could have served a different model under the name "${model}", so those rows stay unlabelled and the background sweep re-embeds them under the new model.`,
				]
			: [
					`Existing vectors were kept: they are labelled "${label}", so setting \`embeddingModel\` to that model reuses them without re-embedding anything.`,
				];
	const body = [
		`Recall used to embed through its own \`embedding\` setting, with the model "${model}". That block no longer does anything.`,
		...kept,
		`Embeddings now come from a provider. Set \`embeddingModel\` (for example \`openai/text-embedding-3-small\`) and give that provider an OpenAI credential — either in auth.json under \`openai\`, or in the \`OPENAI_API_KEY\` environment variable — then delete recall's old \`embedding\` block. Until a model is set, recall searches lexically only.`,
	].join(" ");
	return {
		kind: EMBEDDINGS_MOVED_KIND,
		title: EMBEDDINGS_MOVED_TITLE,
		body,
	};
}
