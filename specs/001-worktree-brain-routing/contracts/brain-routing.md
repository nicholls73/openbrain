# Contract: Worktree Brain Routing

## Scope

This contract covers user-visible and agent-visible behavior for brain routing when commands run inside a git worktree.

## Existing Explicit Mapping

**Given** the current workspace path already matches a configured brain path rule  
**When** any OpenBrain command resolves the active brain  
**Then** OpenBrain uses that explicit mapping  
**And** automatic worktree inheritance does not change `~/.openbrain/config.json`

## Automatic Inheritance

**Given** a source project path is mapped to brain `work`  
**And** a related worktree path has no explicit mapping  
**When** an OpenBrain command resolves the active brain from inside the worktree  
**Then** OpenBrain uses brain `work`  
**And** the worktree path is added to the routing configuration for brain `work`  
**And** later commands from that worktree resolve to `work` without asking

## Ambiguous Routing

**Given** more than one source path mapping could plausibly own the worktree  
**And** no single most-specific source mapping can be chosen safely  
**When** an OpenBrain command resolves the active brain from inside the worktree  
**Then** OpenBrain does not add or change a path mapping  
**And** the command asks the user which brain should own the path when unmatched behavior is `ask`

## Unmapped Source

**Given** the current workspace is a worktree  
**And** its source project has no configured brain mapping  
**When** OpenBrain resolves the active brain  
**Then** OpenBrain follows the existing unmatched-path policy:

- `default`: use the default brain
- `ask`: ask the user to assign a brain before using memory
- `disabled`: skip memory for the path

## Agent Session Hook

**Given** an agent session starts inside a worktree that can inherit from a mapped source project  
**When** the session-start hook runs  
**Then** the hook reports OpenBrain memory as active for the inherited brain  
**And** it does not tell the agent the worktree is unassigned

## Validation Commands

- `openbrain brain current`
- `openbrain memory search "<query>"`
- `openbrain hook session-start`
- `openbrain brain add-path <brain> "<path>"`
