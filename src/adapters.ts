import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { getBrainStatus, initOpenBrain } from "./internal.js";
import { dreamMaybe, listPendingReviews } from "./maintenance.js";
import { claudeHome, claudeSettingsPath, codexHome } from "./paths.js";
import type { BrainStatus, OpenBrainOptions, PendingReview } from "./types.js";

export const OPENBRAIN_BEGIN = "<!-- BEGIN OPENBRAIN -->";
const OPENBRAIN_END = "<!-- END OPENBRAIN -->";

// Stable marker for the Claude Code SessionStart hook command. The adapter keys
// idempotent settings.json merges off this substring, so it must not change.
export const CLAUDE_HOOK_COMMAND = "openbrain hook session-start";

// Detection is deliberately just "does the agent's config directory exist".
// Both CLIs create their directory on first run, and it is the same location
// the adapters write to, so it never force-creates config for an absent agent.
export async function detectCodexAgent(options: OpenBrainOptions = {}) {
  return directoryExists(codexHome(options));
}

export async function detectClaudeAgent(options: OpenBrainOptions = {}) {
  return directoryExists(claudeHome(options));
}

async function directoryExists(dir: string) {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function syncCodexAgent(options: OpenBrainOptions = {}) {
  return syncInstructionFile(codexHome(options), "AGENTS.md", options);
}

export async function syncClaudeAgent(options: OpenBrainOptions = {}, disableAutoMemory = false) {
  const file = await syncInstructionFile(claudeHome(options), "CLAUDE.md", options);
  // The CLAUDE.md block is advisory only. Install a SessionStart hook so Claude
  // Code actually runs daily dreaming and is reminded to search memory on every
  // session, without relying on the agent to follow the instructions.
  await syncClaudeSettings(options, disableAutoMemory);
  return file;
}

// Merge the OpenBrain SessionStart hook into the user's Claude Code
// settings.json, preserving any existing settings and hooks. Idempotent: a
// re-sync replaces our prior entry rather than appending a duplicate.
export async function syncClaudeSettings(options: OpenBrainOptions = {}, disableAutoMemory = false) {
  const file = claudeSettingsPath(options);
  await mkdir(path.dirname(file), { recursive: true });

  let settings: Record<string, unknown> = {};
  try {
    const raw = await readFile(file, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    // Refuse to overwrite content we do not understand: this file belongs to
    // the user, and replacing an unexpected shape with our own would silently
    // discard their configuration.
    if (!isRecord(parsed)) {
      throw new Error(unexpectedSettingsMessage(file, "the top-level value is not an object"));
    }
    settings = parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  if (settings.hooks !== undefined && !isRecord(settings.hooks)) {
    throw new Error(unexpectedSettingsMessage(file, '"hooks" is not an object'));
  }
  const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  if (hooks.SessionStart !== undefined && !Array.isArray(hooks.SessionStart)) {
    throw new Error(unexpectedSettingsMessage(file, '"hooks.SessionStart" is not an array'));
  }
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];

  // Drop any prior OpenBrain command entries, then any group left empty, so
  // repeated syncs never accumulate duplicate hooks.
  const cleaned = sessionStart
    .map((group) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        return group;
      }
      const remaining = group.hooks.filter(
        (entry) =>
          !(
            isRecord(entry) &&
            typeof entry.command === "string" &&
            entry.command.includes(CLAUDE_HOOK_COMMAND)
          )
      );
      return { ...group, hooks: remaining };
    })
    .filter((group) => !(isRecord(group) && Array.isArray(group.hooks) && group.hooks.length === 0));

  cleaned.push({
    hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND }]
  });

  hooks.SessionStart = cleaned;
  settings.hooks = hooks;
  if (disableAutoMemory) {
    settings.autoMemoryEnabled = false;
  }

  await writeFile(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return file;
}

// Body of the `openbrain hook session-start` command. Claude Code runs this at
// session start and injects stdout as context. Never throws: a failing
// SessionStart hook must not block the session. The guidance it returns depends
// on whether a brain is actually available for the current workspace path, so
// it never tells the agent memory is active when it is not.
export async function runSessionStartHook(options: OpenBrainOptions = {}): Promise<string> {
  const cwd = options.cwd ?? process.cwd();

  let status: BrainStatus;
  try {
    status = await getBrainStatus(options);
  } catch {
    // Resolution itself failed; give safe guidance without claiming memory works.
    return [
      "OpenBrain could not resolve a brain for this workspace path.",
      `If this is unexpected, check ~/.openbrain/config.json. Do not assume memory is available for ${cwd}.`
    ].join("\n");
  }

  if (status.state === "ask") {
    return [
      "OpenBrain has no brain assigned to this workspace path.",
      `Ask the user which brain should own this path, then run: openbrain brain add-path <brain> "${cwd}"`,
      "Do not search or record memory until a brain is assigned."
    ].join("\n");
  }
  if (status.state === "disabled") {
    return [
      "OpenBrain is disabled for this workspace path.",
      "Skip memory search and recording for this session."
    ].join("\n");
  }

  // Brain is available: run daily maintenance (best-effort) and give the agent
  // the search/record reminder.
  try {
    await dreamMaybe(options);
  } catch {
    // Dreaming is best-effort. Swallow so the session always starts.
  }
  const lines = [
    `OpenBrain memory is active (brain: ${status.brain}).`,
    `Before starting a task, run: openbrain memory search "<short description of the task>" and use only relevant results.`,
    `After meaningful work, record durable memories with: openbrain memory add --type <preference|workflow|workspace|decision|episode> --text "...".`,
    `Daily dreaming has already been handled for this session.`
  ];

  // Dream proposes; agents dispose. Without this nudge the review files have
  // no consumer and pile up unread, so surfacing them here closes the loop.
  const pending = await listPendingReviews(options).catch(() => [] as PendingReview[]);
  if (pending.length > 0) {
    lines.push(
      `Pending memory reviews (${pending.length}):`,
      ...pending.map((review) => `- ${review.path}`),
      `Read each review file and action its suggestions with openbrain memory promote/update/merge/delete, asking the user only where a judgement call is needed. Never merge or promote without reading the memories first.`,
      `After actioning a review, mark it handled: openbrain review done <file>.`
    );
  }
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unexpectedSettingsMessage(file: string, problem: string) {
  return (
    `OpenBrain cannot update ${file}: ${problem}. ` +
    "Fix or remove the malformed value, then rerun openbrain agents sync claude."
  );
}

async function syncInstructionFile(dir: string, fileName: string, options: OpenBrainOptions = {}) {
  const config = await loadConfig(options);
  await initOpenBrain({ ...options, brain: config.brains.default });
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const block = codexBlock();
  const pattern = new RegExp(`${escapeRegExp(OPENBRAIN_BEGIN)}[\\s\\S]*?${escapeRegExp(OPENBRAIN_END)}`);
  const next = pattern.test(existing)
    ? existing.replace(pattern, block)
    : [existing.trimEnd(), block].filter(Boolean).join("\n\n") + "\n";

  await writeFile(file, next, "utf8");
  return file;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function codexBlock() {
  return `${OPENBRAIN_BEGIN}
## OpenBrain Memory

OpenBrain selects the active brain from the current workspace path using
\`~/.openbrain/config.json\`. Use one default brain for the whole machine, or
map filesystem paths to separate memory containers when the user wants
isolation between contexts.

OpenBrain uses the current workspace path only to choose the active brain.
Treat that brain as the memory container. Refer to memory by brain name or
active brain. Refer to paths only when configuring brain routing or discussing
files. Git worktrees automatically use the brain of their source repository,
so a worktree created from a mapped path needs no extra configuration.

If OpenBrain reports that the current workspace path is not assigned to a brain,
ask the user which brain should own that workspace path, then run:

\`\`\`bash
openbrain brain add-path <brain> "<current workspace path>"
\`\`\`

Before starting a task, run daily maintenance, then search:

\`\`\`bash
openbrain dream maybe --quiet
openbrain memory search "<short description of the user's current task>"
\`\`\`

Use only relevant returned memories.

After a meaningful task, record concise durable memories:

\`\`\`bash
openbrain memory add --type workflow --text "..."
openbrain memory add --type workspace --text "..."
openbrain memory add --type preference --text "..."
openbrain memory add --type decision --text "..."
openbrain memory add --type episode --text "..."
openbrain memory add --type episode --promote-as workflow --text "..."
openbrain memory promote <episode-id> --type workflow --text "..."
\`\`\`

When an existing memory is outdated or a search result already covers the same
fact, revise it instead of adding a near-duplicate:

\`\`\`bash
openbrain memory update <id> --text "..."
openbrain memory merge <source-id> --into <target-id> --text "..."
\`\`\`

If \`memory add\` reports a possible duplicate, follow its suggestion: fold the
fact into the existing memory with \`memory update\` and delete the new copy.

Record durable memories only when the guidance is likely to stay useful across
future tasks. Prefer principles, preferences, repeated workflows, stable
workspace conventions, and durable decisions. Do not store branch names, PR
numbers, commit IDs, stale local state, exact files touched, copied fixture
values, one-off implementation details, or anything likely to drift quickly as
durable memory. If short-lived handoff context is useful, store it as
\`episode\`. Episodes are evidence; durable memories are conclusions.

Use memory types this way:
- \`preference\`: user preferences and standing instructions.
- \`workflow\`: repeated process knowledge, checklists, and classification rules.
- \`workspace\`: stable workspace, toolchain, or recurring task conventions.
- \`decision\`: durable choices and their reason.
- \`episode\`: short-lived session notes, handoff state, or fast-changing facts.

Use metadata only when it materially helps retrieval or review:
- \`--scope <value>\`: narrow retrieval scope.
- \`--confidence low|medium|high\`: confidence in the stored statement.
- \`--sensitivity private\`: local-only memory that requires explicit search opt-in and is never embedded.
- \`--promote-as <durable-type>\`: marks an episode for later review.

Dream writes promotion candidate review files for episodes marked with
\`--promote-as\`. Review source text before running \`openbrain memory promote\`.
Do not promote automatically.

Dream also writes a consolidation review of likely duplicate durable memories
with ready-to-run merge commands. Review the memories before merging; never
merge automatically.

Dream proposes; you dispose. Check for unactioned review files with:

\`\`\`bash
openbrain review list
\`\`\`

Read each pending file and action its suggestions with \`memory promote\`,
\`update\`, \`merge\`, or \`delete\`, asking the user only where a judgement call
is needed. Then mark it handled:

\`\`\`bash
openbrain review done <file>
\`\`\`

If an \`openbrain\` command fails with a sandbox or permission message, the
memory store is outside the sandbox's write allowlist. Ask the user to
approve elevated filesystem access, then rerun the exact same command. Do
not silently skip memory search or recording.

For POC or reference work, classify details before storing them. Keep the
reusable rule, such as how to separate UI, calculation, data contract, fixture,
and product assumption. Avoid storing copied constants or prior implementation
shape unless the user explicitly asks for that context to be remembered.

Never store secrets, credentials, sensitive details, or temporary one-off facts.
${OPENBRAIN_END}`;
}
