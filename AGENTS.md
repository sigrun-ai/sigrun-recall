# AGENTS.md — sigrun-recall

Guidance for coding agents working in this repository.

## What this is

Cross-conversation recall extension for [sigrun](https://github.com/sigrun-ai/sigrun). The default-export factory follows sigrun's pi-durable loader contract. Capture, policy-checked lexical/semantic search, request-only injection, tools, artifacts, backfill, and debug routes share the extension-scoped SQLite database.

## Layout

- `src/index.ts` — factory and lazy host/service wiring.
- `src/db.ts` — schema, migrations, FTS/vector queries, and durable sweep/taint/injection state.
- `src/settings-schema.ts` — the declared settings schemas (shared
  `externalizeBytes`; per user `autoRecall` and `localProviders`) and their types.
- `src/legacy-embedding.ts` — the dead pre-0.3.0 `embedding` group, read off the
  raw settings file for the migration label and the one-boot notice only.
- `src/passages.ts`, `src/redact.ts`, `src/capture.ts` — bounded capture pipeline.
- `src/artifacts.ts` — whole-result files, indexing, outlines, and externalization.
- `src/audience.ts`, `src/policy.ts` — pure sharing/confidentiality rules.
- `src/search.ts`, `src/snippet.ts` — ranked, policy-filtered search.
- `src/embed.ts`, `src/vectors.ts` — optional embeddings and paged cosine index.
- `src/tools.ts`, `src/inject.ts` — model-facing tools and request-only auto-recall.
- `src/backfill.ts`, `src/route.ts` — bounded sweeps and HTTP debug surfaces.
- `test/` — vitest suites with synthetic users and services.
- `dist/` — **committed build output** for git-source installs.

## Run and test

```sh
npm install
npm test            # manifest check + vitest
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/ (commit the result)
```

## Conventions

- **Commit dist**: rebuild and commit `dist/` with every source change.
- **Factory arity is one**: declare the host first and optional test dependencies second; a defaulted host parameter breaks loader host injection.
- **Local development links are not source**: re-point `node_modules/@sigrun/sigrun` and `@sigrun/shared` to the core worktree after `npm install`; never commit those links.
- **Verification before completion**: run `npm test && npm run typecheck && npm run build` and confirm `git status -- dist` is clean.
- Keep access and confidentiality checks on live metadata at every recall egress. Redact text before FTS or remote embedding. Request-only injection must never enter durable entries.
- Tests own their literals: synthetic users, `https://example.invalid/` URLs, no real credentials or services.
- The database uses Node's built-in `node:sqlite`; do not add a native SQLite addon.
