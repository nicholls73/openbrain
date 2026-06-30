# Quickstart: Worktree Brain Routing

## Prerequisites

- Node.js 22+
- pnpm
- git available on `PATH`
- Repository dependencies installed

## Setup

```bash
pnpm install
pnpm build
```

Use a temporary OpenBrain home for manual validation:

```bash
export OPENBRAIN_HOME="$(mktemp -d)"
```

## Scenario 1: Automatic inheritance

1. Create a temporary project and map it to a brain.

   ```bash
   mkdir -p /tmp/openbrain-routing-demo/project
   cd /tmp/openbrain-routing-demo/project
   git init
   git config user.name "OpenBrain Demo"
   git config user.email "openbrain-demo@example.test"
   openbrain init
   openbrain brain add-path work "$PWD"
   ```

2. Create a worktree and run OpenBrain from inside it.

   ```bash
   git commit --allow-empty -m init
   git worktree add ../project-feature
   cd ../project-feature
   openbrain brain current
   ```

Expected result: `work`.

3. Confirm memory commands use the inherited brain without asking.

   ```bash
   openbrain memory search "routing demo"
   ```

Expected result: command runs against brain `work`; it must not print an unassigned-workspace instruction for the worktree.

## Scenario 2: Explicit worktree mapping precedence

1. From the worktree path, assign a different brain.

   ```bash
   openbrain brain add-path experiment "$PWD"
   openbrain brain current
   ```

Expected result: `experiment`.

2. Re-run any routing-triggering command.

   ```bash
   openbrain hook session-start
   ```

Expected result: output says memory is active for `experiment`; config is not changed back to `work`.

## Scenario 3: Unmapped source keeps existing ask behavior

1. Use a fresh `OPENBRAIN_HOME` with path-specific setup or unmatched `ask`.
2. Create a worktree from a project that has no brain mapping.
3. Run:

   ```bash
   openbrain hook session-start
   ```

Expected result: output asks which brain should own the worktree path and does not claim memory is active.

## Automated Validation

```bash
pnpm test
pnpm build
```

Targeted test coverage should prove:

- unmapped worktree inherits source brain
- explicit worktree mapping wins
- ambiguous source mapping asks instead of guessing
- unmapped source follows existing unmatched behavior
- non-worktree path routing remains unchanged
