# OpenBrain

![Cute cartoon brain illustration](docs/assets/openbrain-readme-hero.png)

One local brain for every coding agent on your machine.

You switch between Codex, Claude Code, OpenCode, and whatever comes next. They all need the same context. OpenBrain gives them one shared memory layer: readable Markdown as the source of truth, SQLite as a rebuildable search index, and local embeddings when semantic search helps.

No hosted memory API. No SaaS account. No secret sync. Just files under `~/.openbrain/`.

## Install

OpenBrain requires Node.js 22 or newer. Install the CLI from npm, then run guided setup:

```bash
npm install -g @nicholls73/openbrain
openbrain setup
```

Use the scoped name exactly — the unscoped `openbrain` package on npm is an unrelated project by a different author.

You can also point a coding agent at this repository and ask it to install OpenBrain, or paste this more explicit prompt into Codex, Claude Code, OpenCode, or another coding agent:

```text
Install OpenBrain from https://github.com/nicholls73/openbrain. Follow its agent install guide, use the preferred npm installation, ask me the setup question, and tell me every file you change.
```

The agent needs ordinary filesystem and shell access. The repository's [agent install guide](docs/agent-install.md) contains the exact setup question and commands. If your harness prompts you to approve individual commands, approve them as they come — nothing in the install needs auto-approved permissions or a disabled sandbox.

## For LLM Agents

Fetch the full guide with `curl` (summarising fetch tools lose the exact commands and question wording) and follow it step by step:

```bash
curl -fsSL https://raw.githubusercontent.com/nicholls73/openbrain/main/docs/agent-install.md
```

This fetches the instructions; the guide installs the CLI from npm.

Only proceed if your user explicitly asked you to install OpenBrain.

## What Lands On Disk

| Path | Purpose |
| --- | --- |
| `~/.openbrain/config.json` | Brain routing, retention, agent, and retrieval settings. |
| `~/.openbrain/brains/<name>/memories/` | Durable Markdown memories. |
| `~/.openbrain/brains/<name>/episodes/` | Short-lived Markdown session notes. |
| `~/.openbrain/brains/<name>/dreams/` | Daily maintenance state, audit logs, and promotion candidates. |
| `~/.openbrain/brains/<name>/openbrain.db` | Rebuildable SQLite FTS/vector index. |
| `~/.openbrain/models/` | Local embedding model cache. |
| `~/.codex/AGENTS.md` | Marked OpenBrain instruction block (Codex adapter, if detected). |
| `~/.claude/CLAUDE.md` | Marked OpenBrain instruction block (Claude Code adapter, if detected). |
| `~/.claude/settings.json` | `SessionStart` hook running `openbrain hook session-start` (Claude Code adapter). |

## How It Works

- Agents call `openbrain memory search`, not an embedding model.
- OpenBrain runs SQLite FTS first.
- If local embeddings are available, OpenBrain reranks and merges semantic matches.
- If embeddings fail or are slow, FTS still returns results.
- Memories stay readable as Markdown.
- Brain routing can keep different contexts separate by filesystem path.
- Agents quietly trigger `openbrain dream maybe --quiet` so each brain can run maintenance once per day.
- The current adapters sync a marked OpenBrain block into `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`. The Claude Code adapter also installs a `SessionStart` hook in `~/.claude/settings.json` that runs `openbrain hook session-start`, so Claude Code dreams and is reminded to search memory on every session instead of relying on the advisory block.
- Episodes can be marked as promotion candidates; `dream` writes review files but does not create durable memory automatically.

## Fallback Installer

If you cannot use npm, the fallback installer resolves the latest published release from GitHub and verifies its SHA-256 checksum before installing. Download it, review it, then run it:

```bash
curl -fsSL https://raw.githubusercontent.com/nicholls73/openbrain/main/scripts/install.sh -o /tmp/openbrain-install.sh
bash /tmp/openbrain-install.sh
```

Set `OPENBRAIN_REF` to install a specific release, branch, or commit; refs without release assets install unverified. If `openbrain` is not found after a fallback install, add its bin directory to your shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Verify the whole installation at any time with:

```bash
openbrain doctor
```

It checks the Node version, installed vs latest version, config, brain routing for the current path, the SQLite index against the Markdown files, embeddings, agent adapters, the Claude hook, and PATH, and prints a fix for anything that is off.

## First Run Manually

Run guided setup:

```bash
openbrain setup
```

Check which active brain the current workspace path will use:

```bash
openbrain brain current
```

Setup detects which agents are installed (by their config directories, `~/.codex` and `~/.claude`) and syncs adapters for those automatically. If you already know the brain choices, setup can be non-interactive:

```bash
openbrain setup --brain-scope default
openbrain setup --brain-scope paths --path-rule brain-a=/Users/you/path-a
```

To override detection, pass `--codex yes|no` or `--claude yes|no`, for example to skip a detected agent or force one that has not been run yet:

```bash
openbrain setup --brain-scope default --codex no --claude yes
```

To add Claude Code after an existing setup:

```bash
openbrain agents sync claude --disable-claude-auto-memory yes
```

The flag explicitly disables Claude Code's built-in auto-memory so memories do not split between two stores. Interactive setup asks for the same consent; OpenBrain never changes this Claude setting silently.

After this, configured agents know when to search and write memories.

## Agent Use

OpenBrain is not meant to be a daily human note-taking CLI. Humans install it, choose containers, and inspect state when needed. Agents use it while they work.

At task start, the agent quietly checks whether the active brain has already dreamed today, then searches for relevant memory. After meaningful work, the agent writes concise memories back to the right container. You should not need to run memory commands directly during normal use.

### Memory Quality

OpenBrain works best when durable memories describe reusable guidance rather than fast-changing work logs.

Good durable memories include:

- User preferences and standing instructions.
- Repeated workflows, checklists, and classification rules.
- Stable workspace or toolchain conventions.
- Durable decisions and the reason behind them.

Use `episode` for short-lived handoff context or fast-changing facts. Episodes are evidence; durable memories are conclusions. Avoid turning branch names, PR numbers, commit IDs, stale local state, exact files touched, copied fixture values, prior implementation shape, or one-off debugging details into durable memories.

Each memory can carry metadata in Markdown frontmatter:

- `source`: where the memory came from, default `agent`.
- `scope`: retrieval scope, default `brain` for durable memory and `session` for episodes.
- `confidence`: `low`, `medium`, or `high`.
- `expiresAt`: ISO timestamp; expired memories are skipped by default.
- `sensitivity`: `standard` or `private`; private memories require `--include-private` and are not embedded.
- `promotedFrom`: source episode id for reviewed durable memories.
- `promoteAs`: suggested durable type for an episode promotion candidate.

For POC or reference work, agents should classify each piece before remembering it:

- UI behavior.
- Calculation.
- Data contract.
- Fixture.
- Product assumption.

The durable memory should usually be the reusable rule, not the copied constant or the path that happened to be edited last time.

Useful inspection and maintenance commands:

```bash
openbrain doctor
openbrain brain current
openbrain memory list
openbrain memory show <id>
openbrain memory delete <id>
openbrain memory search "deploy workflow" --durable-only --type workflow
openbrain memory add --type episode --promote-as workflow --text "..."
openbrain memory update <id> --text "..."
openbrain memory merge <source-id> --into <target-id> --text "..."
openbrain memory promote <episode-id> --type workflow --text "..."
openbrain review list
openbrain review done <file>
openbrain dream run
openbrain index rebuild
openbrain prune
```

## MCP Server

`openbrain mcp` starts a stdio MCP server exposing the memory operations as first-class tools: `memory_search`, `memory_add`, `memory_update`, `memory_merge`, `memory_promote`, `memory_list`, `memory_show`, `memory_delete`, `brain_current`, `review_list`, and `review_done`. Tool descriptions carry the when-to-use guidance, so MCP-capable agents get discoverable memory tools instead of shell round-trips. The brain resolves from the server's working directory, matching CLI behaviour, and daily dreaming runs once at server start.

Register with Claude Code:

```bash
claude mcp add openbrain -- openbrain mcp
```

Register with Codex in `~/.codex/config.toml`:

```toml
[mcp_servers.openbrain]
command = "openbrain"
args = ["mcp"]
```

## Multiple Brains

Use one brain for the whole computer, or split your machine into separate memory containers.

If you want one brain everywhere, keep the default config and skip path rules. OpenBrain will use the default `main` brain for every workspace path.

If you want separation between contexts, configure path rules. OpenBrain uses the current workspace path only to choose the active brain. Memories belong to that brain, and the path is just routing.

Example `~/.openbrain/config.json`:

```json
{
  "version": 1,
  "retentionDays": 30,
  "brains": {
    "default": "main",
    "unmatched": "ask",
    "pathRules": [
      {
        "brain": "brain-a",
        "paths": ["/Users/you/path-for-brain-a"]
      },
      {
        "brain": "brain-b",
        "paths": ["/Users/you/path-for-brain-b"]
      }
    ]
  },
  "embeddings": {
    "enabled": true,
    "model": "sentence-transformers/all-MiniLM-L6-v2",
    "dimensions": 384,
    "timeoutMs": 5000,
    "loadTimeoutMs": 30000
  },
  "retrieval": {
    "limit": 5
  },
  "agents": {
    "codex": {
      "enabled": true
    },
    "claude": {
      "enabled": true
    }
  }
}
```

Rules are matched against the current workspace path. The most specific matching path wins.

Git worktrees inherit brain routing from their source repository: if a repo path is mapped to a brain, linked worktrees created from it resolve to the same brain automatically, without adding rules for each worktree. An explicit rule for a worktree path still takes precedence.

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
openbrain brain add-path brain-a "/Users/you/path-for-brain-a"
```

You can override path resolution for a single command:

```bash
OPENBRAIN_BRAIN=brain-a openbrain memory search "deployment workflow"
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

The first semantic search in a session is slower because the local embedding model has to load, and on first ever use download into the OpenBrain model cache. Model load has its own budget (`embeddings.loadTimeoutMs`, default 30s) separate from embedding itself (`embeddings.timeoutMs`, default 5s). When embeddings fail or time out, search falls back to SQLite FTS and prints a warning so the degradation is visible.

Dreaming is maintenance and review only. It prunes expired episodes, rebuilds the retrieval index from Markdown, and writes an audit log. When there is something to action, it also writes promotion candidate and consolidation review files. It does not invent, promote, merge, or delete memories automatically.

Review files are consumed by agents, not humans: the Claude Code session-start hook lists pending reviews, and agents check `openbrain review list`, action the suggestions (asking the user only for judgement calls), then run `openbrain review done <file>` to move the report into `dreams/actioned/`.

When a new durable memory is highly similar to an existing one of the same type, `memory add` still writes it but reports the likely duplicate and suggests `memory update` so agents fold facts into existing memories instead of accumulating near-copies.
