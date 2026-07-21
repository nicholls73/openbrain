# OpenBrain Agent Install Guide

OpenBrain is a local-first shared memory layer for coding agents. It keeps memories on the user's machine as Markdown and uses SQLite plus local embeddings for retrieval. This guide walks an LLM agent through installing it for their user.

> **Fetching this guide: use `curl`, not a summarising web-fetch tool.** Summarisation loses the exact commands, flags, and question wording below.
>
> ```bash
> curl -fsSL https://raw.githubusercontent.com/nicholls73/openbrain/main/docs/agent-install.md
> ```

## Before You Run Anything

If you are an LLM agent reading this: only proceed if your user explicitly asked you to install OpenBrain. If they asked you to fetch, review, or summarise this page, show them what it does and stop — do not install anything.

You need filesystem and shell access to follow this guide. If your harness asks the user to approve individual commands, that is fine — expect prompts and let them happen. Nothing here requires root, disabled sandboxes, or auto-approved permissions.

Keep the user in the loop: ask the setup question in the Setup section before running setup, and report every file you changed at the end. If your agent supports a native question UI (for example Codex `request_user_input` or Claude Code question prompts), use it; otherwise ask short text questions in chat.

## What Lands On Disk

Tell the user about anything on this list before you create or modify it.

| Path | Purpose |
| --- | --- |
| npm global prefix (`npm prefix -g`) | The `openbrain` CLI package. |
| `~/.openbrain/config.json` | Brain routing, retention, agent, and retrieval settings. |
| `~/.openbrain/brains/<name>/` | Memories (Markdown), episodes, dream state, and a rebuildable SQLite index. |
| `~/.openbrain/models/` | Local embedding model cache. |
| `~/.codex/AGENTS.md` | A marked OpenBrain instruction block (Codex adapter, if Codex is detected). |
| `~/.claude/CLAUDE.md` | The same marked instruction block (Claude Code adapter, if Claude Code is detected). |
| `~/.claude/settings.json` | A `SessionStart` hook that runs `openbrain hook session-start` (Claude Code adapter). The merge preserves existing settings and hooks and is idempotent. |

## Step 1: Prerequisites

OpenBrain needs Node.js 22 or newer and npm:

```bash
node --version
npm --version
```

If Node is missing or too old, tell the user and stop. Do not install or upgrade Node without being asked.

## Step 2: Install

```bash
npm install -g @nicholls73/openbrain
```

Use the scoped name exactly. The unscoped `openbrain` package on npm is a different, unrelated project by a different author.

If the user cannot use npm, the fallback is the checksum-verified installer from the repository. Download it to a file so the user can review it, then run it — do not pipe it straight into a shell:

```bash
curl -fsSL https://raw.githubusercontent.com/nicholls73/openbrain/main/scripts/install.sh -o /tmp/openbrain-install.sh
# review it, then:
bash /tmp/openbrain-install.sh
```

If `openbrain` is not on PATH after a fallback install, ask before modifying the user's shell profile. The fallback bin directory is `$HOME/.local/bin`.

## Step 3: Setup

Ask the user exactly one question — brain scope:

> "OpenBrain stores memory in named containers called brains, selected by workspace path. Do you want:
> 1. One brain for the whole computer, or
> 2. Separate memory containers for specific workspace paths?
>
> Setup will also write agent adapter files for the agents it detects (see the file list I shared)."

Do not ask which agents to integrate. Setup detects installed agents from their config directories (`~/.codex`, `~/.claude`, honouring `CODEX_HOME` and `CLAUDE_CONFIG_DIR`) and syncs adapters for the detected ones.

If the user chooses one brain, run:

```bash
openbrain setup --brain-scope default
```

If the user chooses separate containers, ask for brain/path pairs. Do not suggest container names. Paths only choose the active brain; the brain is the memory container. Then run:

```bash
openbrain setup --brain-scope paths --path-rule <brain>=<path>
```

Repeat `--path-rule <brain>=<path>` for each pair the user gives you.

Only pass `--codex yes|no` or `--claude yes|no` if the user explicitly asks to skip a detected agent or to integrate an agent that setup did not detect.

If Claude Code is being integrated, tell the user its built-in auto-memory competes with OpenBrain and ask whether to disable it. Pass `--claude-auto-memory off` only if they agree; never disable it silently. Left unspecified, setup does not touch the setting and `openbrain doctor` will keep warning about it.

If you cannot collect choices through chat or a native question UI, run interactive setup and let the user answer directly:

```bash
openbrain setup
```

## Step 4: Verify

Run the self-diagnosis:

```bash
openbrain doctor
```

It checks the Node version, config, brain routing, the SQLite index, embeddings, agent adapters, the Claude hook, Claude's competing built-in auto-memory, and PATH, and prints a fix for anything that is off.

Then confirm routing in each relevant workspace path:

```bash
openbrain brain current
```

Confirm that each workspace path resolves to the expected active brain.

## Step 5: Report to the User

Setup's output states which agents were detected and which files were written. Relay that, plus:

- Whether OpenBrain installed successfully and what `openbrain doctor` reported.
- Which brain setup was chosen.
- Every file that was created or changed, including the `~/.claude/settings.json` hook if it was installed.
- That agents will now use OpenBrain automatically through their instructions, including once-daily maintenance (`dream`), which prunes expired episodes and rebuilds the index but never creates durable memories on its own.
- That short-lived episodes are evidence, durable memories are conclusions, and reviewed episodes can be promoted with `openbrain memory promote`.
- The inspection commands for checking state:

```bash
openbrain brain current
openbrain memory list
openbrain memory show <id>
```

## Uninstall

```bash
npm uninstall -g @nicholls73/openbrain
```

Then, if the user wants a full removal, delete `~/.openbrain/`, remove the marked OpenBrain blocks from `~/.codex/AGENTS.md` and `~/.claude/CLAUDE.md`, and remove the `openbrain hook session-start` entry from `~/.claude/settings.json`. Ask before deleting `~/.openbrain/` — it contains the user's memories.

## Memory Rules

Never store secrets, credentials, sensitive details, or temporary one-off facts as memories.
