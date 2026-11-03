# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-11-03

### Added

- The search route accepts `?exclude=<conversationId>` so callers can reproduce auto-recall's exclusion of the current conversation (eval fidelity).
- The eval harness (`scripts/recall-eval.ts`) supports a per-pair `exclude` field with client-side filtering, and over-fetches when excluding so filtered hits don't consume the top-k window.

### Fixed

- (from polish wave 1, 0.1.2) The shutdown drain is bounded and its race timer clears on fast settles.

## [0.1.2] - Unreleased

### Fixed

- Bound the shutdown drain: each round races `Promise.allSettled(pending)` against a timer for the remaining budget, so a capture whose embedding fetch never settles can no longer hang `harnessShutdown` past the 30s deadline; the database still closes.

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
