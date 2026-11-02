# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

### TODO

- Pin `@sigrun/sigrun` and `@sigrun/shared` to the released versions carrying core C1 once they ship, replacing their development `file:` specifiers.

### Added

- Idempotent capture of conversation turns, tool calls/results, and whole large tool results with redacted porter/trigram indexes.
- Live audience and confidentiality enforcement, optional semantic embeddings, and bounded recency-ranked search.
- Replay-safe `recall_search`/`recall_open` tools and byte-stable request-only automatic recall.
- Rotating, resumable backfill cron task plus user search and admin sweep routes.
