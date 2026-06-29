# OpenBrain Constitution

## Core Principles

### I. Local-First Memory
OpenBrain keeps user memory on the local machine. Features must preserve readable Markdown as the source of truth under `~/.openbrain/`, with SQLite and embeddings treated as rebuildable indexes. Do not introduce hosted services, account requirements, or remote memory sync without an explicit product decision.

### II. Agent-Facing Workflow
OpenBrain is primarily infrastructure for coding agents, not a human note-taking app. UX, docs, commands, and defaults must optimize for agents searching relevant memory at task start and recording durable conclusions after meaningful work.

### III. Durable Memory Quality
Durable memories must capture stable preferences, workflows, workspace conventions, and decisions. Fast-changing facts, branch names, PR numbers, copied constants, exact files touched, and one-off implementation details belong in episodes or should not be stored.

### IV. Explicit Routing Boundaries
Workspace paths are only routing inputs for choosing the active brain. Product language, docs, and code should refer to memory by active brain or brain name, except when configuring or explaining path routing.

### V. Testable CLI Contracts
All behavior exposed through `openbrain` commands must remain scriptable and testable. Prefer deterministic stdout/stderr, idempotent setup/sync operations, and focused tests for command behavior, filesystem side effects, and memory policy rules.

## Technical Constraints

OpenBrain is a TypeScript CLI targeting Node.js 22+ with `pnpm` as package manager. Keep the install path compatible with `scripts/install.sh`, preserve existing user state under `~/.openbrain/`, and avoid adding runtime dependencies unless they are necessary for local-first memory behavior.

## Development Workflow

Use repo-native validation before shipping changes:

- `pnpm build`
- `pnpm test`

Specs should call out changes to memory storage, routing, adapter sync behavior, install/update behavior, and privacy boundaries explicitly.

## Governance

This constitution guides Spec Kit planning for this repository. Changes require a clear rationale in the relevant spec or plan, plus migration notes when existing user state, agent instructions, or memory semantics are affected.

**Version**: 1.0.0 | **Ratified**: 2026-06-29 | **Last Amended**: 2026-06-29
