# @sigrun/recall

Cross-conversation recall for [sigrun](https://github.com/sigrun-ai/sigrun), as an optional pi-durable extension.

`@sigrun/recall` will index conversation passages and large tool results in a local SQLite database, then make relevant past material available through automatic recall and explicit tools. Access, sharing, and confidentiality are evaluated when material is recalled.

This is the initial package scaffold: it provides the database, settings resolution, and extension factory. Capture, search, injection, tools, routes, and Hermes import are not implemented yet.

## Development

```sh
npm install
npm test            # manifest check + vitest
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/ (commit the result)
```

`dist/` is committed by design: git-source installs load `dist/index.js` without a build step. Tests use synthetic data and do not contact external services.
