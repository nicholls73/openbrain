# OpenBrain

OpenBrain is a local-first shared memory layer for coding agents. The MVP starts with Codex: Markdown files are the source of truth, and SQLite indexes those files for retrieval with full-text search plus local embeddings.

## MVP Behavior

- Stores local state in `~/.openbrain/`.
- Uses `~/.openbrain/config.json` to map filesystem paths to separate brains.
- Keeps each brain isolated under `~/.openbrain/brains/<name>/`.
- Keeps durable memories as Markdown in each brain's `memories/` folder.
- Keeps short-lived episode notes in each brain's `episodes/` folder.
- Uses each brain's `openbrain.db` as a rebuildable search index.
- Uses `sentence-transformers/all-MiniLM-L6-v2` locally through Transformers.js for semantic retrieval.
- Syncs a marked OpenBrain instruction block into `~/.codex/AGENTS.md`.

## Commands

Install from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/nicholls73/openbrain/main/scripts/install.sh | bash
```

If `openbrain` is not found after install, add the default bin directory to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Local development:

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
node dist/cli.js brain current
node dist/cli.js index rebuild
node dist/cli.js prune
```

For local development, set `OPENBRAIN_HOME` and `CODEX_HOME` to test against temporary directories.

## Multiple Brains

OpenBrain can keep work and personal memories separate by resolving the current working directory to a configured brain.

Example `~/.openbrain/config.json`:

```json
{
  "version": 1,
  "retentionDays": 30,
  "brains": {
    "default": "personal",
    "unmatched": "ask",
    "pathRules": [
      {
        "brain": "work",
        "paths": ["/Users/you/Documents/work", "/Users/you/Documents/GitHub/work-client"]
      },
      {
        "brain": "personal",
        "paths": ["/Users/you/Documents/personal", "/Users/you/Documents/openbrain"]
      }
    ]
  },
  "embeddings": {
    "enabled": true,
    "model": "sentence-transformers/all-MiniLM-L6-v2",
    "dimensions": 384,
    "timeoutMs": 5000
  },
  "retrieval": {
    "limit": 5
  },
  "agents": {
    "codex": {
      "enabled": true
    }
  }
}
```

Rules are matched against the current working directory. The most specific matching path wins.

`brains.unmatched` controls what happens when no rule matches:

- `default`: use `brains.default`.
- `disabled`: do not use OpenBrain for that path.
- `ask`: tell the agent to ask which brain owns the path before using OpenBrain.

Use this to check the active brain:

```bash
openbrain brain current
```

After deciding which brain owns a path:

```bash
openbrain brain add-path work "/Users/you/Documents/work/client-repo"
```

You can override path resolution for a single command:

```bash
OPENBRAIN_BRAIN=work openbrain memory search "deployment workflow"
```

## Notes

The first semantic search can be slower because the local embedding model has to load and may need to download into the OpenBrain model cache. Search falls back to SQLite FTS when embeddings are unavailable.
