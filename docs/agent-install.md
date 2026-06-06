# OpenBrain Agent Install Guide

You are installing OpenBrain for the user. OpenBrain is a local-first shared memory layer for coding agents.

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
2. Separate brain containers for paths like work and personal projects.

If the user chooses one brain, keep the default brain for all paths.

If the user chooses separate brain containers, ask which filesystem paths belong to each brain. Then run:

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

Never store secrets, credentials, sensitive personal details, or temporary one-off facts as memories.
