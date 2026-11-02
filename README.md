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

## Development and uninstall

```sh
npm install
npm test
npm run typecheck
npm run build
```

`dist/` is committed by design for git-source installs. Tests use synthetic data and do not contact external services. To uninstall recall data, remove the extension and delete `<data>/recall.db` plus `<data>/artifacts/`.
