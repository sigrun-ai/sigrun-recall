# AGENTS.md — sigrun-recall

Guidance for coding agents working in this repository.

## What this is

Cross-conversation recall extension for [sigrun](https://github.com/sigrun-ai/sigrun). The default-export factory follows sigrun's pi-durable loader contract. The package keeps its recall index in the extension-scoped SQLite database; later tasks add capture, policy-checked search, and recall surfaces.

## Layout

- `src/index.ts` — public factory surface.
- `src/db.ts` — SQLite schema, migrations, and item/index bookkeeping.
- `src/config.ts` — extension-wide and per-user settings resolution.
- `test/` — vitest suites.
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
- Tests own their literals: synthetic users, `https://example.invalid/` URLs, no real credentials or services.
- The database uses Node's built-in `node:sqlite`; do not add a native SQLite addon.
