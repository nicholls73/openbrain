# Data Model: Worktree Brain Routing

## Brain

Represents a named memory container.

**Fields**

- `name`: Normalized brain name.
- `home`: Local directory for memories, episodes, dreams, and index data.

**Validation Rules**

- Brain names use existing OpenBrain normalization.
- No new hosted or remote brain state is introduced.

## Workspace Path Mapping

Represents configured routing from local workspace paths to a brain.

**Fields**

- `brain`: Brain name.
- `paths`: Canonical local paths routed to that brain.

**Relationships**

- A brain can own many paths.
- A path should resolve to the most-specific matching path rule.

**Validation Rules**

- Existing explicit paths must not be removed or reassigned by worktree inheritance.
- Added inherited paths must use the same canonicalization as `openbrain brain add-path`.

## Worktree Relationship

Represents a local git relationship between a source project and a worktree path.

**Fields**

- `sourcePath`: Canonical path for the source project or owning worktree root.
- `worktreePath`: Canonical path for the current worktree.
- `candidateMappings`: Matching configured path rules that could own the source project.

**Relationships**

- One source project can have many worktree paths.
- A worktree path may also have its own explicit Workspace Path Mapping.

**Validation Rules**

- If `worktreePath` already matches an explicit mapping, inheritance must not modify it.
- If no source mapping exists, OpenBrain must keep the existing unmatched behavior.
- If multiple source mappings are equally plausible, OpenBrain must ask instead of choosing.

## Inheritance Decision

Represents the result of evaluating routing for the current workspace path.

**States**

- `explicit`: Current path already resolves through an existing mapping.
- `inherited`: Current worktree path was added to the source brain.
- `ask`: Routing is ambiguous or no mapped source brain is available while unmatched policy requires user choice.
- `default`: Existing default unmatched behavior applies.
- `disabled`: Existing disabled unmatched behavior applies.

**Validation Rules**

- `explicit` has highest precedence.
- `inherited` is allowed only for one unambiguous source brain.
- `ask`, `default`, and `disabled` must preserve existing user-facing semantics for unmatched paths.

## State Transitions

```text
unmapped worktree + one mapped source brain
  -> inherited

unmapped worktree + no mapped source brain
  -> ask/default/disabled according to existing unmatched policy

mapped worktree
  -> explicit

unmapped worktree + equally plausible mapped sources
  -> ask
```
