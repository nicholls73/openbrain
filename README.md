# OpenBrain

OpenBrain is a local-first shared memory layer for coding agents. The MVP starts with Codex: Markdown files are the source of truth, and SQLite indexes those files for retrieval with full-text search plus local embeddings.

## MVP Behavior

- Stores local state in `~/.openbrain/`.
- Keeps durable memories as Markdown in `~/.openbrain/memories/`.
- Keeps short-lived episode notes in `~/.openbrain/episodes/`.
- Uses `~/.openbrain/openbrain.db` as a rebuildable search index.
- Uses `sentence-transformers/all-MiniLM-L6-v2` locally through Transformers.js for semantic retrieval.
- Syncs a marked OpenBrain instruction block into `~/.codex/AGENTS.md`.

## Commands

```bash
pnpm install
pnpm build

node dist/cli.js init
node dist/cli.js agents sync codex
node dist/cli.js memory add --type workflow --text "Prefer pnpm for TypeScript projects."
node dist/cli.js memory search "TypeScript package manager"
node dist/cli.js memory list
node dist/cli.js memory show <id>
node dist/cli.js memory delete <id>
node dist/cli.js index rebuild
node dist/cli.js prune
```

For local development, set `OPENBRAIN_HOME` and `CODEX_HOME` to test against temporary directories.

## Notes

The first semantic search can be slower because the local embedding model has to load and may need to download into the OpenBrain model cache. Search falls back to SQLite FTS when embeddings are unavailable.
