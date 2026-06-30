# Feature Specification: Worktree Brain Routing

**Feature Branch**: `[001-worktree-brain-routing]`

**Created**: 2026-06-29

**Status**: Draft

**Input**: User description: "https://github.com/nicholls73/openbrain/issues/11"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Worktree Inherits Source Brain (Priority: P1)

As an agent working in a new worktree for a project that already has an assigned brain, I need the worktree to use the same active brain so memory lookup, workspace conventions, and task guidance remain consistent.

**Why this priority**: This is the core user value. A worktree is still the same project context, so losing brain routing breaks the normal OpenBrain task-start workflow.

**Independent Test**: Can be fully tested by configuring a project path to use a brain, creating or detecting a related worktree, and confirming the worktree resolves to that same brain without extra manual setup.

**Acceptance Scenarios**:

1. **Given** a project path is mapped to brain `work`, **When** a new worktree for that project is created or detected, **Then** the worktree path is mapped to brain `work`.
2. **Given** an agent starts inside the new worktree, **When** OpenBrain chooses the active brain, **Then** it uses the source project's brain instead of reporting an unassigned path or falling back to an unrelated default.

---

### User Story 2 - Explicit Worktree Mapping Is Preserved (Priority: P2)

As a user who has intentionally assigned a worktree path to a different brain, I need OpenBrain to preserve that explicit routing choice so automatic inheritance does not overwrite my configuration.

**Why this priority**: Explicit routing boundaries are part of OpenBrain's memory privacy and context model. Automatic behavior must not silently change user decisions.

**Independent Test**: Can be fully tested by assigning a source project to one brain, assigning its worktree path to another brain, triggering worktree inheritance, and confirming the worktree keeps its explicit brain.

**Acceptance Scenarios**:

1. **Given** a source project maps to brain `work` and a related worktree path already maps to brain `experiment`, **When** OpenBrain processes worktree routing, **Then** the worktree remains mapped to brain `experiment`.
2. **Given** an explicit worktree mapping exists, **When** the source project's mapping changes later, **Then** the worktree mapping is not changed unless the user changes it directly.

---

### User Story 3 - Ambiguous Routing Asks Before Changing (Priority: P3)

As a user with overlapping or unclear path mappings, I need OpenBrain to avoid guessing the wrong brain for a worktree and ask for a clear choice when inheritance cannot be determined safely.

**Why this priority**: Ambiguous routing is less common than straightforward inheritance, but a wrong brain can expose irrelevant or sensitive context to the task.

**Independent Test**: Can be fully tested by configuring multiple plausible source mappings for a worktree relationship and confirming no automatic assignment occurs until the user selects the owning brain.

**Acceptance Scenarios**:

1. **Given** multiple configured paths could plausibly own a worktree, **When** OpenBrain evaluates the worktree routing, **Then** it asks the user which brain should own the worktree before adding a mapping.
2. **Given** no source path for the worktree has an assigned brain, **When** an agent starts inside the worktree, **Then** OpenBrain follows the existing unassigned-workspace flow instead of inventing a brain assignment.

### Edge Cases

- Source project path is not assigned to any brain.
- Worktree path already has an explicit brain mapping.
- Multiple configured source paths match the same worktree relationship.
- Worktree path is nested under another configured workspace path with a different brain.
- Worktree was created outside OpenBrain-aware tooling and is only detected later.
- Source project mapping is removed after a worktree mapping has already been inherited.
- Worktree path no longer exists when routing maintenance runs.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: OpenBrain MUST identify when a workspace path belongs to a worktree whose source project path has an assigned brain.
- **FR-002**: OpenBrain MUST assign an unmapped worktree path to the same brain as its mapped source project when the relationship is unambiguous.
- **FR-003**: OpenBrain MUST preserve any existing explicit mapping for a worktree path and must not overwrite it during automatic inheritance.
- **FR-004**: OpenBrain MUST ask the user to choose the owning brain when multiple candidate source mappings are plausible and no single most-specific match can be determined safely.
- **FR-005**: OpenBrain MUST keep the existing unassigned-workspace behavior when neither the worktree path nor its source project path has an assigned brain.
- **FR-006**: OpenBrain MUST treat workspace paths only as routing inputs and describe the resulting memory context by active brain or brain name in user-facing output.
- **FR-007**: OpenBrain MUST make inherited worktree routing visible enough for agents and users to understand which brain is active and why.
- **FR-008**: OpenBrain MUST avoid remote services, accounts, or hosted state for worktree routing.
- **FR-009**: OpenBrain MUST preserve existing user memory and routing configuration while adding inherited worktree mappings.
- **FR-010**: OpenBrain MUST provide testable behavior for automatic inheritance, explicit mapping precedence, ambiguous routing, and unassigned source projects.

### Key Entities *(include if feature involves data)*

- **Brain**: A named memory container selected for a workspace. It owns memory lookup, durable memory storage, and task guidance for that context.
- **Workspace Path Mapping**: A configured association between a filesystem path and a brain. Existing explicit mappings take precedence over inherited mappings.
- **Worktree Relationship**: A relationship between a source project path and one or more worktree paths that represent the same project context.
- **Inheritance Decision**: The outcome of evaluating a worktree path: inherit source brain, preserve explicit mapping, ask user, or leave unassigned.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In 100% of unambiguous cases where a source project has a brain and the related worktree has no explicit mapping, the worktree resolves to the source project's brain.
- **SC-002**: In 100% of cases where a worktree path already has an explicit mapping, automatic inheritance leaves that mapping unchanged.
- **SC-003**: In 100% of ambiguous routing cases, OpenBrain asks for user confirmation before adding or changing a worktree mapping.
- **SC-004**: Agents starting inside inherited worktrees can complete normal task-start memory lookup without seeing an unassigned-workspace message.
- **SC-005**: Existing path routing behavior for non-worktree workspaces remains unchanged.
- **SC-006**: The feature is covered by automated checks for automatic inheritance, explicit mapping precedence, ambiguous routing, and unassigned source behavior.

## Assumptions

- A worktree belongs to the same project context as its source project unless the user explicitly maps it to a different brain.
- The most-specific configured source path is the preferred owner when more than one configured path could match and one is clearly more specific.
- Automatic inheritance may create a normal path-to-brain mapping for the worktree so future agent sessions resolve consistently.
- Removing or changing inherited mappings after creation follows existing routing configuration behavior unless a later feature defines lifecycle cleanup.
- This feature does not change memory storage format, memory content, or brain selection rules for non-worktree paths.
