# OpenBrain Agent Install Guide

You are installing OpenBrain for the user.

Do the install. Ask the setup questions. Verify the result. Do not guess which folders belong to which brain.

OpenBrain is a local-first shared memory layer for coding agents. It keeps memories on the user's machine as Markdown and uses SQLite plus local embeddings for retrieval.

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

## Initialize

Run:

```bash
openbrain init
```

## Choose Brain Setup

Before changing configuration, ask the user whether they want:

1. One brain for the whole computer.
2. Separate memory containers for specific filesystem paths.

If the user chooses one brain, keep the default brain for all paths. Do not create path rules.

If the user chooses separate memory containers, ask them to name each container and provide the filesystem paths that belong to it. Do not suggest container names. Then run:

```bash
openbrain brain add-path <brain> "<path>"
```

Repeat that command for each path the user gives you.

## Verify Routing

Run this in each relevant folder:

```bash
openbrain brain current
```

Confirm that each folder resolves to the expected brain.

## Agent Setup

OpenBrain currently ships a Codex adapter. Ask before modifying agent instruction files.

If the user wants Codex integration, run:

```bash
openbrain agents sync codex
```

## Finish

Tell the user:

- Whether OpenBrain installed successfully.
- Which brain setup was chosen.
- Which files were changed.
- The exact commands they can use next:

```bash
openbrain brain current
openbrain memory search "project workflow"
openbrain memory add --type workflow --text "Prefer pnpm for TypeScript projects."
```

Never store secrets, credentials, sensitive details, or temporary one-off facts as memories.
