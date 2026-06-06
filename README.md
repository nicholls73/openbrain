# OpenBrain

One local brain for every coding agent on your machine.

You switch between Codex, Claude Code, OpenCode, and whatever comes next. They all need the same context. OpenBrain gives them one shared memory layer: readable Markdown as the source of truth, SQLite as a rebuildable search index, and local embeddings when semantic search helps.

No hosted memory API. No SaaS account. No secret sync. Just files under `~/.openbrain/`.

## For Humans

Strongly recommended: let an agent install OpenBrain for you. The setup involves shell access, PATH checks, optional brain routing, and agent instruction files. Agents are good at following that checklist.

Paste this into Codex, Claude Code, OpenCode, or another coding agent running in full privilege mode:

```text
Using full privilege mode with local filesystem and shell access, install OpenBrain for me by following this setup guide: https://raw.githubusercontent.com/nicholls73/openbrain/main/docs/agent-install.md
```

Full privilege mode means the agent can read and write local files and run shell commands. It does not mean root access.

## What Lands On Disk

| Path | Purpose |
| --- | --- |
| `~/.openbrain/config.json` | Brain routing, retention, agent, and retrieval settings. |
| `~/.openbrain/brains/<name>/memories/` | Durable Markdown memories. |
| `~/.openbrain/brains/<name>/episodes/` | Short-lived Markdown session notes. |
| `~/.openbrain/brains/<name>/openbrain.db` | Rebuildable SQLite FTS/vector index. |
| `~/.openbrain/models/` | Local embedding model cache. |

## How It Works

- Agents call `openbrain memory search`, not an embedding model.
- OpenBrain runs SQLite FTS first.
- If local embeddings are available, OpenBrain reranks and merges semantic matches.
- If embeddings fail or are slow, FTS still returns results.
- Memories stay readable as Markdown.
- Brain routing can keep work and personal contexts separate by filesystem path.
- The current adapter syncs a marked OpenBrain block into `~/.codex/AGENTS.md`.

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

Initialize local state:

```bash
openbrain init
```

Wire Codex into OpenBrain:

```bash
openbrain agents sync codex
```

Check which brain the current folder will use:

```bash
openbrain brain current
```

After this, Codex knows when to search and write memories.

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

Use one brain for the whole computer, or split your machine into separate brain containers.

If you want one brain everywhere, keep the default config and skip path rules. OpenBrain will use the default `personal` brain for every folder.

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
