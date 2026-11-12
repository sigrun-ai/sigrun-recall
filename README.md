# @sigrun/recall

Cross-conversation recall for [sigrun](https://github.com/sigrun-ai/sigrun), as an optional pi-durable extension.

Recall indexes conversation turns, tool calls/results, and complete large tool results in an extension-scoped SQLite database. Settled runs are captured incrementally; a ten-minute backfill job also visits imported or interrupted conversations. Search combines porter stemming, trigram substring matching, optional embeddings, and recency. The model can use `recall_search` and `recall_open`; automatic recall adds bounded, clearly marked reference material to new user messages.

## Settings and secrets

Recall declares its settings as JSON Schema, so the extension page is a generated form. Shared settings: `externalizeBytes` (default `24576`). Per-user settings: `autoRecall` (default `true`) applies live, and one user's settings never touch another user's file. Locality is controlled by the admin's per-extension switch, not by user settings.

```json
{ "externalizeBytes": 24576 }
```

A malformed value falls back to its default, repairing only the smallest failing node. A settings file that still carries the pre-0.3.0 `embedding` group loads unchanged: the group is not part of the schema, so it is kept but inert. At startup, a user with a stored non-empty `localProviders` list is told once that locality moved to the admin switch, and that retired key is removed from the user's settings file.

## Embeddings

Recall embeds through sigrun's core embedding registry (`host.embeddings`), so models, credentials and the local-only gate are configured in one place for the whole server instead of per extension.

- **Which model.** The `embeddingModel` core setting (`provider/model`) names the default. There is no silent default: with none set, recall searches lexically only. A model in `embeddings.localModels` (and one its provider does not veto) may also receive `local-only` text.
- **Credential.** The default OpenAI model (`openai/text-embedding-3-small`) needs the `openai` credential in `auth.json`, or `OPENAI_API_KEY` in the sigrun environment/page.
- **Switching models.** Vectors are keyed by model, so a switch never loses the old index: the sweep re-embeds into the new model in the background while queries keep using the previous model's vectors, and the old rows are dropped only once the new model covers every item. Queries use the newest model whose coverage is complete, falling back to the current default.
- **Local-only items** are submitted with `confidentiality: "local-only"`; a model core does not trust for local material leaves them lexical (no vector, still text-searchable).
- **Failures** never break search: a missing model, an unconfigured credential or a timeout degrades that call to lexical results. The query path budgets 800 ms per call.

### Migrating from recall's own `embedding` block

Recall used to embed through its own `embedding` settings block and `embedding-api-key` secret. Both are gone; the block no longer does anything, and recall raises one notice per boot telling the primary admin what happened. If the old block named `api.openai.com` and a model, existing vectors were kept and labelled `openai/<model>` — setting `embeddingModel` to that model reuses them. Any other endpoint could have served a different model under that name, so those vectors are re-embedded under the new model.

## Access and confidentiality

Items are `normal` or `local-only`. Local-only material reaches only models whose full provider/model id is marked local by the admin switch; an absent model fails closed. Recall also re-checks live conversation sharing for every reader of the calling conversation: material shared later becomes visible, and revoked sharing stops matching immediately. Internal conversations are never indexed or recalled. Displaying local-only material taints subsequent capture in the calling conversation.

Auto-recall includes relevant earlier material from the current conversation and its fork ancestors, while job runs remain excluded. With sittings, that material is pre-boundary only; without a boundary, the existing in-context rule still excludes the current conversation's items. Explicit `recall_search` can include both the current conversation and job runs. Stored injection blocks are reused byte-for-byte where policy allows and are kept for the conversation's life (they are small; v1 does not prune them).

## Sittings

A **sitting** is a run of activity in one conversation without a long pause. When a later user message starts a new sitting, recall gives the model the current sitting, the previous exchange, and a table of contents of earlier sittings instead of continually growing the full-history context. The user's transcript remains unchanged.

Three live settings control this: shared `sittings.minGapMinutes` (default `60`) and `sittings.minHistoryTokens` (default `8000`), and the per-user `sittings` switch (default `true`). The minimum gap is also raised to the chat model's longest declared prompt-cache lifetime when that is longer. A pause alone does not start a sitting if there is too little history to trim.

Automatic recall includes relevant pre-boundary material from the current conversation, including inherited history from a fork's ancestors. Material already in the current sitting is not injected again. The explicit `recall_search` and `recall_open` tools can always reach everything, including the current conversation.

Sigrun 0.16.0 adds the host calls used for transcript dividers and per-sitting automatic titles (`host.conversations.markContext` and `setAutoName`). Recall feature-detects both: older cores still get sitting-shaped requests, but no divider or automatic sitting title. A name typed by a person always takes precedence over an automatic title.

Threshold compaction is declined when there is nothing in the current sitting to compress. An overflow or manual compaction whose cut is at or before the sitting boundary receives a fixed summary pointing to the table of contents and recall. Compaction never re-summarizes earlier sittings.

## Large results and reading

Complete tool results larger than `externalizeBytes` are stored whole under `artifacts/`, indexed in bounded passages, and replaced in model output by a head, outline, and handle. Truncated or spilled shell output is not externalized because the hook no longer has the complete result; complete shell output over the threshold is externalized. `recall_open` accepts `{offset, length}` for byte-based artifact slices; the spec's `section` option is deferred.

Trigram search cannot match CJK substrings shorter than three characters. Use at least three characters for those queries.

## Published hooks

Recall publishes three extension-to-extension hooks (schema-validated through sigrun's core registry). Other extensions call them by name; payloads are typebox schemas exported from `src/hooks.ts` and re-exported from the package root.

- `recall.index` — input `{ id (1..256), kind (1..64), title (≤512), text, date (ISO), url?, class?: "normal" | "local-only", sources? (≤100 handles) }`; output `{ handle, class, changed }`. Stores a user-owned document and returns a `d:<id>` handle. Repeating an identical payload leaves the store untouched and returns `changed: false`. The stored class is the strictest of `class` (default `normal`) and the classes of any `sources` items that exist — documents (`d:`), passages (`r:`) and artifacts (`a:`) all resolve to their live class; unknown handles are ignored.
- `recall.remove` — input `{ id }`; output `{ removed }`. Deletes the document and its index rows.
- `recall.search` — input `{ query, limit? (1..50, default 10), kinds? (turn|tool|artifact|doc), model?: { provider, modelId } }`; output `{ hits: [{ handle, kind, title, date, snippet, class, provider?, id? }] }`. Doc hits carry `provider` (the storing extension's slug) and `id`. Job items are included; the calling conversation is not excluded. Without a `model`, only `normal` items surface; a `model` marked local by the admin switch also sees `local-only` items. When a `conversationId` is present, access follows that conversation's live sharing; otherwise the call acts as a private conversation of the user.

Identity: `recall.index` and `recall.remove` require a user and fail with `"recall.<name> needs a user"` when the caller has none; `recall.search` without a user returns `{ hits: [] }`. Documents are keyed `(caller extension slug, user, id)`, so one extension cannot overwrite another's records, and a doc hit's `provider` names the extension that stored it.

## Development and uninstall

```sh
npm install
npm test
npm run typecheck
npm run build
```

`dist/` is committed by design for git-source installs. Tests use synthetic data and do not contact external services. To uninstall recall data, remove the extension and delete `<data>/recall.db` plus `<data>/artifacts/`.
