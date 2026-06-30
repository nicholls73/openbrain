# Research: Worktree Brain Routing

## Decision: Inherit only when the source mapping is unambiguous

**Rationale**: The safest behavior is to preserve existing explicit routing and only add inheritance when OpenBrain can determine a single owning brain. This matches the issue acceptance criteria and the constitution's explicit routing boundary principle.

**Alternatives considered**:

- Always use the default brain for unmapped worktrees. Rejected because path-specific users intentionally isolated project memories.
- Always inherit from the nearest configured parent path. Rejected because a nested path rule can be unrelated to the actual git worktree source.
- Always ask for every worktree. Rejected because straightforward worktree use should not interrupt normal agent startup.

## Decision: Store inherited worktree routing as a normal path rule

**Rationale**: OpenBrain already persists brain routing as path rules in `~/.openbrain/config.json`. Adding the worktree path to the selected brain makes future commands deterministic and avoids repeated detection after the first successful inheritance.

**Alternatives considered**:

- Compute inheritance every time without saving. Rejected because it repeats filesystem work and can produce changing behavior if source metadata later disappears.
- Add a new inherited-rule metadata format. Rejected for v1 because it requires config migration without improving the required behavior.
- Store worktree metadata in a separate file. Rejected because routing configuration already has a source of truth.

## Decision: Preserve explicit worktree mappings before inheritance

**Rationale**: Users may intentionally route an experimental worktree to another brain. Existing path rules are explicit configuration and must take precedence over automatic inference.

**Alternatives considered**:

- Let source-project mapping override the worktree mapping. Rejected because it violates explicit routing boundaries.
- Warn but override when the source path changes. Rejected because a warning is not enough when memory context may be sensitive.

## Decision: Use most-specific configured source path only when clearly unique

**Rationale**: Current path rule behavior already prefers the most-specific path. Worktree inheritance should follow that model when there is a single most-specific candidate, but ask when multiple candidates remain equally plausible.

**Alternatives considered**:

- Pick the first configured path. Rejected because config order should not decide sensitive memory context.
- Ask whenever multiple paths match. Rejected because nested path rules can be safely resolved when one candidate is strictly more specific.

## Decision: Keep user-facing output centered on the active brain

**Rationale**: OpenBrain's constitution says paths are routing inputs, while memory context should be described by brain name or active brain. Worktree explanations may mention the path only when explaining routing setup or why a mapping was added.

**Alternatives considered**:

- Include source and worktree paths in every command output. Rejected because normal memory commands should not become noisy.
- Hide all inheritance details. Rejected because agents need enough context to understand why memory is active in a worktree.

## Decision: Validate through existing CLI flows and focused routing tests

**Rationale**: The behavior matters when agents call `openbrain brain current`, `openbrain memory search`, and the session-start hook. Tests should prove those flows resolve the expected brain and preserve existing mappings.

**Alternatives considered**:

- Only unit-test helper functions. Rejected because persistence and CLI-facing behavior are part of the contract.
- Require manual git worktree fixtures only. Rejected because automated tests should be deterministic and fast.
