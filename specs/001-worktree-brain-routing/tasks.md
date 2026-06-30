# Tasks: Worktree Brain Routing

**Input**: Design documents from `/specs/001-worktree-brain-routing/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/brain-routing.md, quickstart.md

**Tests**: Required by spec SC-006. Write story tests before implementation and confirm they fail for the missing behavior.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish current routing surface and deterministic git worktree test support.

- [X] T001 Review current brain routing call sites in `src/brains.ts`, `src/openbrain.ts`, `src/types.ts`, and `tests/openbrain.test.ts`
- [X] T002 [P] Add local git repository/worktree fixture helpers for routing tests in `tests/openbrain.test.ts`
- [X] T003 [P] Add config assertion helper for path rule persistence checks in `tests/openbrain.test.ts`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core routing primitives that must exist before user stories can be implemented.

**Critical**: No user story work can begin until this phase is complete.

- [X] T004 Define worktree routing result shape and candidate mapping concepts in `src/brains.ts`
- [X] T005 Implement reusable most-specific path rule matching helper in `src/brains.ts`
- [X] T006 Implement single-pass local git worktree relationship discovery helper in `src/brains.ts`
- [X] T007 Add inherited mapping persistence entry point around existing config save flow in `src/openbrain.ts`

**Checkpoint**: Brain resolution can inspect existing path rules, detect worktree relationships, and persist an inherited path without changing story behavior yet.

---

## Phase 3: User Story 1 - Worktree Inherits Source Brain (Priority: P1) MVP

**Goal**: An unmapped worktree for a mapped source project resolves to the source project's brain and becomes mapped for future sessions.

**Independent Test**: Configure a source project path to brain `work`, create a related worktree, run OpenBrain from the worktree, and confirm the active brain is `work` with no unassigned-workspace message.

### Tests for User Story 1

- [X] T008 [P] [US1] Add failing test for `getCurrentBrain` inheriting source brain from an unmapped worktree in `tests/openbrain.test.ts`
- [X] T009 [P] [US1] Add failing test that inherited worktree routing is written to `config.brains.pathRules` in `tests/openbrain.test.ts`
- [X] T010 [P] [US1] Add failing test that `runSessionStartHook` reports active inherited brain from a worktree in `tests/openbrain.test.ts`

### Implementation for User Story 1

- [X] T011 [US1] Implement unambiguous source-brain inheritance for unmapped worktree paths in `src/brains.ts`
- [X] T012 [US1] Persist inherited worktree path under the source brain path rule in `src/openbrain.ts`
- [X] T013 [US1] Ensure `getCurrentBrain`, `searchMemories`, and `runSessionStartHook` use inherited brain routing in `src/openbrain.ts`
- [X] T014 [US1] Validate automatic inheritance scenario from `specs/001-worktree-brain-routing/quickstart.md`

**Checkpoint**: User Story 1 is fully functional and independently testable.

---

## Phase 4: User Story 2 - Explicit Worktree Mapping Is Preserved (Priority: P2)

**Goal**: Existing explicit mappings for a worktree path always win over automatic inheritance.

**Independent Test**: Map a source project to brain `work`, map the worktree path to brain `experiment`, trigger routing from the worktree, and confirm the worktree remains on `experiment`.

### Tests for User Story 2

- [X] T015 [P] [US2] Add failing test that explicit worktree mapping wins over source-brain inheritance in `tests/openbrain.test.ts`
- [X] T016 [P] [US2] Add failing test that a later source mapping change does not overwrite explicit worktree mapping in `tests/openbrain.test.ts`

### Implementation for User Story 2

- [X] T017 [US2] Short-circuit worktree inheritance when current path already matches a path rule in `src/brains.ts`
- [X] T018 [US2] Ensure inherited mapping persistence is skipped for explicit current-path mappings in `src/openbrain.ts`
- [X] T019 [US2] Validate explicit mapping precedence scenario from `specs/001-worktree-brain-routing/quickstart.md`

**Checkpoint**: User Stories 1 and 2 both work independently.

---

## Phase 5: User Story 3 - Ambiguous Routing Asks Before Changing (Priority: P3)

**Goal**: Ambiguous or unmapped source relationships do not create guessed mappings; existing unmatched behavior is preserved.

**Independent Test**: Configure multiple plausible source mappings or no source mapping, run OpenBrain from the worktree, and confirm it asks instead of assigning the wrong brain.

### Tests for User Story 3

- [X] T020 [P] [US3] Add failing test that equally plausible source mappings leave worktree unmapped and ask the user in `tests/openbrain.test.ts`
- [X] T021 [P] [US3] Add failing test that unmapped worktree source follows `ask`, `default`, and `disabled` unmatched behavior in `tests/openbrain.test.ts`

### Implementation for User Story 3

- [X] T022 [US3] Implement ambiguous candidate detection and no-save result in `src/brains.ts`
- [X] T023 [US3] Preserve existing unmatched error and session hook messages for unresolved worktrees in `src/openbrain.ts`
- [X] T024 [US3] Validate unmapped source behavior from `specs/001-worktree-brain-routing/quickstart.md`

**Checkpoint**: All user stories are independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and documentation alignment.

- [X] T025 [P] Update manual validation notes if implementation changes expected commands in `specs/001-worktree-brain-routing/quickstart.md`
- [X] T026 Run focused routing tests in `tests/openbrain.test.ts`
- [X] T027 Run full test suite with `pnpm test` for `package.json`
- [X] T028 Run TypeScript build with `pnpm build` for `tsconfig.json`
- [X] T029 Review final routing behavior against contract in `specs/001-worktree-brain-routing/contracts/brain-routing.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies; can start immediately.
- **Foundational (Phase 2)**: Depends on Setup completion; blocks all user stories.
- **US1 (Phase 3)**: Depends on Foundational; MVP scope.
- **US2 (Phase 4)**: Depends on Foundational and can be implemented after or alongside US1 once shared routing helpers exist.
- **US3 (Phase 5)**: Depends on Foundational and can be implemented after or alongside US1/US2 once shared routing helpers exist.
- **Polish (Phase 6)**: Depends on selected user stories being complete.

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational; no dependency on US2 or US3.
- **User Story 2 (P2)**: Can start after Foundational; verifies precedence over inheritance but should remain independently testable.
- **User Story 3 (P3)**: Can start after Foundational; verifies unresolved cases without depending on US1/US2 completion.

### Within Each User Story

- Write tests first and confirm they fail.
- Implement `src/brains.ts` routing behavior before `src/openbrain.ts` persistence/session integration.
- Validate each story using its quickstart scenario before moving to the next priority.

### Parallel Opportunities

- T002 and T003 can run in parallel after T001.
- T008, T009, and T010 can run in parallel for US1.
- T015 and T016 can run in parallel for US2.
- T020 and T021 can run in parallel for US3.
- Once Phase 2 is done, US2 and US3 tests can be drafted while US1 implementation proceeds.
- T025 can run in parallel with validation once behavior is known.

---

## Parallel Example: User Story 1

```text
Task: "Add failing test for getCurrentBrain inheriting source brain from an unmapped worktree in tests/openbrain.test.ts"
Task: "Add failing test that inherited worktree routing is written to config.brains.pathRules in tests/openbrain.test.ts"
Task: "Add failing test that runSessionStartHook reports active inherited brain from a worktree in tests/openbrain.test.ts"
```

---

## Parallel Example: User Story 2

```text
Task: "Add failing test that explicit worktree mapping wins over source-brain inheritance in tests/openbrain.test.ts"
Task: "Add failing test that a later source mapping change does not overwrite explicit worktree mapping in tests/openbrain.test.ts"
```

---

## Parallel Example: User Story 3

```text
Task: "Add failing test that equally plausible source mappings leave worktree unmapped and ask the user in tests/openbrain.test.ts"
Task: "Add failing test that unmapped worktree source follows ask, default, and disabled unmatched behavior in tests/openbrain.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 setup.
2. Complete Phase 2 routing primitives.
3. Complete Phase 3 automatic inheritance.
4. Stop and validate `getCurrentBrain`, `searchMemories`, and `runSessionStartHook` from an inherited worktree.

### Incremental Delivery

1. Setup + Foundational establishes deterministic worktree detection and path rule matching.
2. US1 delivers useful inherited brain routing for normal worktree use.
3. US2 protects explicit user routing choices.
4. US3 handles ambiguous and unmapped cases without unsafe guesses.
5. Polish validates contract, quickstart, full tests, and build.

### Parallel Team Strategy

1. One agent completes Setup + Foundational.
2. Separate agents can write US1, US2, and US3 tests in parallel.
3. Implementation should merge through `src/brains.ts` carefully because all stories touch routing logic.

---

## Notes

- Preserve existing non-worktree routing behavior.
- Do not add runtime dependencies unless required by local git/worktree detection.
- Do not change memory storage format or durable memory semantics.
- Keep user-facing language centered on active brain or brain name; mention paths only for routing setup/explanation.
