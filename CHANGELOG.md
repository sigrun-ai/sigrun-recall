# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Declare recall's settings as JSON Schema through `host.settings.declare`, so
  the settings page is a generated form instead of a JSON box: the shared
  `externalizeBytes` and the per-user `autoRecall` / `localProviders`. The
  hand-written parser (`src/config.ts`) is gone — core applies the same
  defaults (`24576`, `true`, `[]`) and repairs a malformed stored value to
  them, with a load-time warning and an admin notice instead of a
  `console.warn`. Requires sigrun 0.13.0 or newer; the `@sigrun/shared` peer
  floor rises to `0.13.0`.
- The per-user settings are read through the declared handle at REQUEST time,
  never in the factory body, so an edited user setting applies without a
  restart (`x-sigrun-apply: "live"` on both keys).
- **Posture change:** a malformed `localProviders` entry used to discard the
  whole list; core repairs at the smallest failing node, so only the bad entry
  is dropped and the rest of the list keeps working.

### Removed

- The `embedding` settings group is no longer declarable: embeddings come from
  `host.embeddings`, and the group is read only by the 0.3.0 migration (the v4
  vector label and the one-per-boot "embeddings moved to a provider" notice).
  A file that still carries it loads unchanged — the key survives as a stored
  key the schema does not declare.

## [0.3.0] - 2026-11-09

### Changed

- Recall embeds through sigrun's core embedding registry instead of its own
  `embedding` settings block: `host.embeddings.embed` with the live
  `embeddingModel` default, the query path's 800 ms budget, and core's
  local-only gate. `src/embed.ts`, the `embedding-api-key` secret and the
  `embedding` settings block are gone (requires sigrun 0.12.0, the release
  carrying `host.embeddings`; the `@sigrun/shared` peer floor rises to
  `0.12.0`).
- Vectors are keyed by model, so a model switch never loses the old index:
  the sweep re-embeds into the new model in the background while queries keep
  using the previous model's vectors, and the old rows are dropped only once
  the new model covers every item. Queries use the newest model whose coverage
  is complete, falling back to the current default.
- Local-only items are submitted with `confidentiality: "local-only"`; a model
  core does not trust for local material leaves them lexical instead of
  embedding them. Capture-time embedding sends two calls per page, one per
  confidentiality class, and stores each vector under the model the provider
  returned.

### Added

- One notice per boot for the primary admin when recall's settings still carry
  the dead `embedding` block: which model the block named, whether the existing
  vectors were kept (labelled `openai/<model>`) or are re-embedded, and that
  `embeddingModel` plus an OpenAI credential must be set.

## [0.2.1] - 2026-11-08

- CI: test against the latest released core (core-ref: release). No code change.

## [0.2.0] - 2026-11-08

### Added

- Deleted conversations are not recalled: search and auto-recall exclude
  conversations marked deleted, and stored injections forget deleted
  sources too (requires sigrun core's deleted-conversations release;
  older cores never mark conversations deleted, so nothing changes for
  them).

### Changed

- peer pi-durable/pi-ai/chord ~1.5.0 (requires sigrun 0.11.0).

### Fixed

- afterTool skips results of calls that never ran (pi-durable 1.5.0 hook semantics).


<!-- Pin note: the published-hooks seam requires core ≥ 0.9.0 (the
     release carrying `host.publishedHooks`) and the embeddings swap
     requires core ≥ 0.12.0 (the release carrying `host.embeddings`; this
     line's `@sigrun/shared` peer floor). This repo's dev link tracks
     core's main directly; an older core leaves recall lexical-only
     rather than erroring. -->

### Added

- Published hooks `recall.index`, `recall.remove` and `recall.search`: the extension-to-extension seam that lets other extensions store, delete and search user-owned documents. Documents are keyed `(caller, user, id)`; a stored document's class is the strictest of its declared class and the classes of its existing `sources`; search without a user returns no hits and without a model surfaces only `normal` items.
- User-owned documents (schema v3): documents with no conversation, surfaced in search
  (`recall_search` kind `"record"`), `recall_open` (`d:` handles), auto-recall and the
  embedding sweep — owner-private through the audience rule at every egress, `local-only`
  docs only embedded by local endpoints. Ordered v2→v3 migration preserves item ids and
  FTS rows; v1 databases migrate through too.

### Fixed (0.1.5, folded into this line)

- The `@sigrun/shared` peer accepts every line since the runtime value imports landed
  (`0.5.0 || 0.6.0 || 0.6.1 || 0.7.0 || 0.8.0`). It was pinned to a bare `0.5.0`, so a
  host running any later 0.x read as unaccepted even though the contract is unchanged —
  the host links its own copy, so the declaration only ever expressed intent.

## [0.1.4] - 2026-11-04

### Fixed

- The shutdown drain is bounded by a hard deadline: a capture-embedding fetch that never
  settles can no longer hang the drain (each round races `Promise.allSettled` against the
  remaining time, and the race's timer is cleared so fast settles leave no live timer).
- Parked-minors rollup: embedPending readback matches the embedding's `blockIndex`;
  dead `void vectorIndex` statements removed; uncaught `entry()` rejections handled;
  byte-slicing never splits a codepoint; join separators counted against the byte cap;
  `--limit` validated; `as never` casts removed; the CLI/convert source lists and the
  userSettings closure deduplicated (full per-item ledger in the pass notes).

[0.1.4]: the polish-pass release; includes all of 0.1.3's line (the version was
minted at the pass's start from the 0.1.2 drain work).

## [0.1.3] - 2026-11-03

### Added

- The search route accepts `?exclude=<conversationId>` so callers can reproduce auto-recall's exclusion of the current conversation (eval fidelity).
- The eval harness (`scripts/recall-eval.ts`) supports a per-pair `exclude` field with client-side filtering, and over-fetches when excluding so filtered hits don't consume the top-k window.

### Fixed

- (from polish wave 1, 0.1.2) The shutdown drain is bounded and its race timer clears on fast settles.

## [0.1.2] - Unreleased

### Fixed

- Bound the shutdown drain: each round races `Promise.allSettled(pending)` against a timer for the remaining budget, so a capture whose embedding fetch never settles can no longer hang `harnessShutdown` past the 30s deadline; the database still closes.
- Automatic recall degrades to lexical search when settings/embedder resolution fails transiently and retries on the next turn instead of permanently losing semantic search for the process lifetime.
- `embedPending` now matches pending passages on `blockIndex` as well as message and offset, so a wrong block can no longer be silently vectorized with another block's text.
- Injection blocks no longer split a UTF-8 codepoint when truncating snippets to the byte budget, and the header, join separators, and ellipsis now count against the 1536-byte snippet budget.
- `recall_open`'s neighboring-turn rendering truncates at the byte cap without splitting codepoints and counts the join separators against the cap.
- The Hermes import CLI validates `--limit` as a positive integer and reuses the converter's exported root-source list instead of a duplicated inline copy.
- The artifact store is created once per process instead of on every externalization/search call, and the backfill sweep uses typed `ConversationId`/`EntryQuery` casts instead of `as never`.

## [0.1.1] - Unreleased

### Fixed

- Version bump only: 0.1.0 was occupied by a registry-side staging artifact and is permanently unavailable; this is the initial published release.

## [0.1.0] - Unreleased

### Changed (release pinning)

- `@sigrun/shared` is pinned as a peer at `0.5.0` (runtime VALUE imports — `accessOf` — ride the peer, with the dev `file:` link to core's workspace, the ext-gateway family posture).
- `@sigrun/sigrun` stays the development `file:../sigrun` link (types-only consumption; core 0.5.0 carries C1 on the registry — but this repo never imports it at runtime, so no pin is needed for installs).

### Added

- Idempotent capture of conversation turns, tool calls/results, and whole large tool results with redacted porter/trigram indexes.
- Live audience and confidentiality enforcement, optional semantic embeddings, and bounded recency-ranked search.
- Replay-safe `recall_search`/`recall_open` tools and byte-stable request-only automatic recall.
- Rotating, resumable backfill cron task plus user search and admin sweep routes.
