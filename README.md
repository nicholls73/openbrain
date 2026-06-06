# OpenBrain

OpenBrain is a local-first shared memory layer for coding agents. It gives agents a shared brain on your machine while keeping memories readable, path-scoped, and under your control. Markdown files are the source of truth, and SQLite indexes those files for retrieval with full-text search plus local embeddings.

## How It Works

- Stores local state in `~/.openbrain/`.
- Uses `~/.openbrain/config.json` to map filesystem paths to separate brains.
- Keeps each brain isolated under `~/.openbrain/brains/<name>/`.
- Keeps durable memories as Markdown in each brain's `memories/` folder.
- Keeps short-lived episode notes in each brain's `episodes/` folder.
- Uses each brain's `openbrain.db` as a rebuildable search index.
- Uses `sentence-transformers/all-MiniLM-L6-v2` locally through Transformers.js for semantic retrieval.
- Syncs a marked OpenBrain instruction block into `~/.codex/AGENTS.md`.

## Install With An Agent

Copy this into Codex, Claude Code, OpenCode, or another coding agent:

```text
Install OpenBrain for me by following this setup guide: https://raw.githubusercontent.com/nicholls73/openbrain/main/docs/agent-install.md
```

The agent should install OpenBrain, ask the setup questions, configure brain routing if needed, and verify the result.

## Install Manually

Install OpenBrain from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/nicholls73/openbrain/main/scripts/install.sh | bash
```

If `openbrain` is not found after install, add the default bin directory to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## First Run Manually

Initialize OpenBrain's local state:

```bash
openbrain init
```

Sync the Codex adapter into `~/.codex/AGENTS.md`:

```bash
openbrain agents sync codex
```

Check which brain the current folder will use:

```bash
openbrain brain current
```

After this, Codex should be able to find OpenBrain from its startup instructions.

## Daily Use

Search existing memories:

```bash
openbrain memory search "TypeScript package manager"
```

Add a durable memory:

```bash
openbrain memory add --type workflow --text "Prefer pnpm for TypeScript projects."
```

Useful follow-up commands:

```bash
openbrain memory list
openbrain memory show <id>
openbrain memory delete <id>
openbrain index rebuild
openbrain prune
```

## Multiple Brains

OpenBrain can use one brain for your whole computer, or separate brain containers for different filesystem paths.

If you want one brain everywhere, use the default config and skip path rules. OpenBrain will use the default `personal` brain for every folder.

If you want separation between work and personal projects, configure path rules. OpenBrain resolves the current working directory to a brain before reading or writing memories.

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

## Local Development

For contributors working on OpenBrain itself:

```bash
pnpm install
pnpm build
pnpm test
```

Set `OPENBRAIN_HOME` and `CODEX_HOME` to test against temporary directories.

## Notes

The first semantic search can be slower because the local embedding model has to load and may need to download into the OpenBrain model cache. Search falls back to SQLite FTS when embeddings are unavailable.
