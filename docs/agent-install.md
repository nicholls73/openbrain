# OpenBrain Agent Install Guide

You are installing OpenBrain for the user.

Do the install. Ask only the setup questions needed. Verify the result. Do not guess which workspace paths belong to which brain.

OpenBrain is a local-first shared memory layer for coding agents. It keeps memories on the user's machine as Markdown and uses SQLite plus local embeddings for retrieval.

If your agent supports a native question UI, use it for setup choices. Examples include Codex `request_user_input` and Claude Code question-style prompts. If no native question UI is available, ask short text questions in chat.

## Permission Requirement

This guide expects the agent to be running with full local filesystem and shell access.

Full privilege mode means the agent can read and write local files and run shell commands. It does not mean root access.

## Install

Run the curl installer:

```bash
curl -fsSL https://raw.githubusercontent.com/nicholls73/openbrain/main/scripts/install.sh | bash
```

If `openbrain` is not found after install, ask before modifying the user's shell profile. The default bin directory is:

```bash
$HOME/.local/bin
```

## Setup Questions

Ask this first:

1. One brain for the whole computer.
2. Separate memory containers for specific workspace paths.

If the user chooses one brain, run:

```bash
openbrain setup --brain-scope default --codex yes --claude yes
```

If the user chooses separate memory containers, ask for brain/path pairs. Do not suggest container names. Paths only choose the active brain; the brain is the memory container. Then run:

```bash
openbrain setup --brain-scope paths --path-rule <brain>=<path> --codex yes --claude yes
```

Repeat `--path-rule <brain>=<path>` for each pair the user gives you.

If the user does not want Codex integration, use `--codex no`. If the user does not want Claude Code integration, use `--claude no`.

If you cannot collect choices through chat or native question UI, run interactive setup:

```bash
openbrain setup
```

## Verify Routing

Run this in each relevant workspace path:

```bash
openbrain brain current
```

Confirm that each workspace path resolves to the expected active brain.

## Agent Setup

OpenBrain currently ships Codex and Claude Code adapters. `openbrain setup --codex yes --claude yes` writes them.

The Codex adapter writes an instruction block to `AGENTS.md`. The Claude Code adapter writes the same instruction block to `CLAUDE.md` and also installs a `SessionStart` hook in `~/.claude/settings.json` (honouring `CLAUDE_CONFIG_DIR`). The hook runs `openbrain hook session-start`, which performs daily dreaming and prints a reminder to search memory before tasks and record it after. The instruction block alone is advisory, so the hook is what makes Claude Code use OpenBrain on every session. The merge preserves existing settings and hooks and is idempotent across re-syncs.

The adapters will call `openbrain dream maybe --quiet` before memory search. OpenBrain decides whether the active brain has already dreamed today. Dreaming prunes expired episodes, rebuilds the index from Markdown, and writes promotion candidate review files. It does not create durable memories automatically.

## Finish

Tell the user:

- Whether OpenBrain installed successfully.
- Which brain setup was chosen.
- Which files were changed.
- That agents should now use OpenBrain automatically through their instructions, including once-daily dreaming.
- That short-lived episodes are evidence, durable memories are conclusions, and reviewed episodes can be promoted with `openbrain memory promote`.
- The inspection commands they can run if they want to check state:

```bash
openbrain brain current
openbrain memory list
openbrain memory show <id>
```

Never store secrets, credentials, sensitive details, or temporary one-off facts as memories.
