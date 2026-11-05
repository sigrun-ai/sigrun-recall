# @sigrun/recall

Cross-conversation recall for [sigrun](https://github.com/sigrun-ai/sigrun), as an optional pi-durable extension.

Recall indexes conversation turns, tool calls/results, and complete large tool results in an extension-scoped SQLite database. Settled runs are captured incrementally; a ten-minute backfill job also visits imported or interrupted conversations. Search combines porter stemming, trigram substring matching, optional embeddings, and recency. The model can use `recall_search` and `recall_open`; automatic recall adds bounded, clearly marked reference material to new user messages.

## Settings and secrets

Extension settings support `externalizeBytes` (default `24576`) and an optional `embedding` object:

```json
{
  "externalizeBytes": 24576,
  "embedding": {
    "url": "https://example.invalid/embed",
    "model": "embed-model",
    "local": false,
    "timeoutMs": 800
  }
}
```

The optional `embedding-api-key` secret authorizes the `[OI]`-compatible embeddings endpoint. Embeddings are sent in batches and only when configured; failures leave lexical search available. Per-user settings support `autoRecall` (default `true`) and `localProviders` (default `[]`).

## Access and confidentiality

Items are `normal` or `local-only`. Local-only material reaches only models whose provider is in the item owner's `localProviders`; an absent model or unknown owner fails closed. Recall also re-checks live conversation sharing for every reader of the calling conversation: material shared later becomes visible, and revoked sharing stops matching immediately. Internal conversations are never indexed or recalled. Displaying local-only material taints subsequent capture in the calling conversation.

Auto-recall excludes the current conversation and job runs; explicit `recall_search` can include both. Stored injection blocks are reused byte-for-byte where policy allows and are kept for the conversation's life (they are small; v1 does not prune them).

## Large results and reading

Complete tool results larger than `externalizeBytes` are stored whole under `artifacts/`, indexed in bounded passages, and replaced in model output by a head, outline, and handle. Truncated or spilled shell output is not externalized because the hook no longer has the complete result; complete shell output over the threshold is externalized. `recall_open` accepts `{offset, length}` for byte-based artifact slices; the spec's `section` option is deferred.

Trigram search cannot match CJK substrings shorter than three characters. Use at least three characters for those queries.

## Published hooks

Recall publishes three extension-to-extension hooks (schema-validated through sigrun's core registry). Other extensions call them by name; payloads are typebox schemas exported from `src/hooks.ts` and re-exported from the package root.

- `recall.index` — input `{ id (1..256), kind (1..64), title (≤512), text, date (ISO), url?, class?: "normal" | "local-only", sources? (≤100 handles) }`; output `{ handle, class, changed }`. Stores a user-owned document and returns a `d:<id>` handle. Repeating an identical payload leaves the store untouched and returns `changed: false`. The stored class is the strictest of `class` (default `normal`) and the classes of any `sources` items that exist — documents (`d:`), passages (`r:`) and artifacts (`a:`) all resolve to their live class; unknown handles are ignored.
- `recall.remove` — input `{ id }`; output `{ removed }`. Deletes the document and its index rows.
- `recall.search` — input `{ query, limit? (1..50, default 10), kinds? (turn|tool|artifact|doc), model?: { provider, modelId } }`; output `{ hits: [{ handle, kind, title, date, snippet, class, provider?, id? }] }`. Doc hits carry `provider` (the storing extension's slug) and `id`. Job items are included; the calling conversation is not excluded. Without a `model`, only `normal` items surface; a `model` whose provider is in the owner's `localProviders` also sees `local-only` items. When a `conversationId` is present, access follows that conversation's live sharing; otherwise the call acts as a private conversation of the user.

Identity: `recall.index` and `recall.remove` require a user and fail with `"recall.<name> needs a user"` when the caller has none; `recall.search` without a user returns `{ hits: [] }`. Documents are keyed `(caller extension slug, user, id)`, so one extension cannot overwrite another's records, and a doc hit's `provider` names the extension that stored it.

## Development and uninstall

```sh
npm install
npm test
npm run typecheck
npm run build
```

`dist/` is committed by design for git-source installs. Tests use synthetic data and do not contact external services. To uninstall recall data, remove the extension and delete `<data>/recall.db` plus `<data>/artifacts/`.
