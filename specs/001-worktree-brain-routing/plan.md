# Implementation Plan: Worktree Brain Routing

**Branch**: `[001-worktree-brain-routing]` | **Date**: 2026-06-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-worktree-brain-routing/spec.md`

## Summary

OpenBrain should keep memory routing consistent when agents work in git worktrees. The plan extends existing path-based brain resolution so an unmapped worktree can inherit the same brain as its mapped source project, while preserving explicit worktree mappings and refusing to guess in ambiguous cases. The implementation remains local-first and uses the existing config file as the only persistent routing source.

## Technical Context

**Language/Version**: TypeScript 5.9, Node.js 22+

**Primary Dependencies**: Existing Node.js standard library, Vitest, current OpenBrain modules

**Storage**: Existing `~/.openbrain/config.json` path rules; no memory storage migration

**Testing**: Vitest via `pnpm test`; TypeScript build via `pnpm build`

**Target Platform**: Local macOS/Linux/Unix-like developer machines with git worktree support

**Project Type**: CLI and local library

**Performance Goals**: Brain resolution for a worktree should complete fast enough to remain invisible during normal agent startup and memory commands; worktree detection should be a single-pass check during resolution, and inherited mappings should be persisted so later commands use normal path-rule matching without repeating worktree discovery.

**Constraints**: Preserve local-first memory, preserve explicit path rules, avoid remote state, keep stdout/stderr deterministic for CLI flows, and keep non-worktree routing unchanged.

**Scale/Scope**: One user's local OpenBrain installation, dozens of path rules and worktrees, multiple agents starting from different workspaces.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Local-First Memory**: PASS. Uses local git/workspace metadata and `~/.openbrain/config.json`; no hosted service or account.
- **Agent-Facing Workflow**: PASS. Fixes agent startup and memory lookup behavior in worktrees.
- **Durable Memory Quality**: PASS. Does not change memory creation rules or durable/episode classification.
- **Explicit Routing Boundaries**: PASS. Explicit worktree mappings win; path language remains limited to routing setup/explanation.
- **Testable CLI Contracts**: PASS. Behavior is scriptable through existing commands and covered by focused tests.

## Project Structure

### Documentation (this feature)

```text
specs/001-worktree-brain-routing/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── brain-routing.md
└── tasks.md
```

### Source Code (repository root)

```text
src/
├── brains.ts       # brain resolution, path rule matching, worktree inheritance helpers
├── openbrain.ts    # preparation flow, current brain, memory commands, session hook behavior
├── config.ts       # existing config loading/saving shape
├── cli.ts          # existing user-visible commands that exercise routing
└── types.ts        # shared config/options types if a small routing result shape is needed

tests/
└── openbrain.test.ts
```

**Structure Decision**: Keep implementation in the existing single-package CLI layout. Put routing logic close to existing brain resolution in `src/brains.ts`, call persistence from `src/openbrain.ts` where config saving already exists, and extend `tests/openbrain.test.ts` with focused path/worktree routing coverage.

## Phase 0: Research

See [research.md](./research.md).

## Phase 1: Design

See [data-model.md](./data-model.md), [contracts/brain-routing.md](./contracts/brain-routing.md), and [quickstart.md](./quickstart.md).

## Post-Design Constitution Check

- **Local-First Memory**: PASS. Design stores only local path routing in existing config and reads local worktree metadata.
- **Agent-Facing Workflow**: PASS. Session-start and memory lookup flows inherit routing automatically in straightforward worktree cases.
- **Durable Memory Quality**: PASS. No changes to memory type semantics, retention, dreams, or promotion.
- **Explicit Routing Boundaries**: PASS. Explicit mapping precedence and ambiguous-case ask behavior are first-class requirements and tests.
- **Testable CLI Contracts**: PASS. Quickstart defines scriptable validation via `openbrain brain current`, `openbrain memory search`, `openbrain hook session-start`, and config assertions.

## Complexity Tracking

No constitution violations.
