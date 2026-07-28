import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { OpenBrainConfig, OpenBrainOptions } from "./types.js";

const DEFAULT_BRAIN = "main";

export function resolveBrainName(config: OpenBrainConfig, options: OpenBrainOptions = {}) {
  return resolveBrain(config, options).brain;
}

export interface BrainResolution {
  brain: string;
  enabled: boolean;
  matchedRule: boolean;
  unmatched: OpenBrainConfig["brains"]["unmatched"];
  cwd: string;
}

export class BrainUnavailableError extends Error {
  constructor(readonly resolution: BrainResolution) {
    super(brainUnavailableMessage(resolution));
  }
}

export function resolveBrain(config: OpenBrainConfig, options: OpenBrainOptions = {}): BrainResolution {
  const explicit = options.brain ?? process.env.OPENBRAIN_BRAIN;
  if (explicit) {
    return {
      brain: sanitizeBrainName(explicit),
      enabled: true,
      matchedRule: false,
      unmatched: config.brains.unmatched,
      cwd: normalizePath(options.cwd ?? process.cwd())
    };
  }

  const cwd = normalizePath(options.cwd ?? process.cwd());
  const match = matchPathRule(config, cwd);
  if (match) {
    return {
      brain: sanitizeBrainName(match.brain),
      enabled: true,
      matchedRule: true,
      unmatched: config.brains.unmatched,
      cwd
    };
  }

  // A git worktree is the same project context as its source repo, so an
  // unmatched path that is a linked worktree inherits the source repo's
  // brain. An explicit rule for the worktree path wins above; this only runs
  // when nothing matched, and never writes config.
  if (config.brains.pathRules.length > 0) {
    const sourceRoot = gitMainWorktreeRoot(cwd);
    if (sourceRoot && sourceRoot !== cwd) {
      const sourceMatch = matchPathRule(config, sourceRoot);
      if (sourceMatch) {
        return {
          brain: sanitizeBrainName(sourceMatch.brain),
          enabled: true,
          matchedRule: true,
          unmatched: config.brains.unmatched,
          cwd
        };
      }
    }
  }

  const unmatched = config.brains.unmatched ?? "default";
  return {
    brain: sanitizeBrainName(config.brains.default ?? DEFAULT_BRAIN),
    enabled: unmatched === "default",
    matchedRule: false,
    unmatched,
    cwd
  };
}

export function canonicalPathForRule(value: string) {
  return normalizePath(expandHome(value));
}

function matchPathRule(config: OpenBrainConfig, targetPath: string) {
  return config.brains.pathRules
    .flatMap((rule) =>
      rule.paths.map((rulePath) => ({
        brain: rule.brain,
        path: normalizePath(expandHome(rulePath))
      }))
    )
    .filter((rule) => targetPath === rule.path || targetPath.startsWith(`${rule.path}${path.sep}`))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

// Root of the source (main) worktree when cwd is inside a git worktree, or
// undefined when git is unavailable, cwd is not a repo, or the layout is
// unexpected (e.g. bare repos). Best-effort by design: any failure just means
// no inheritance.
function gitMainWorktreeRoot(cwd: string): string | undefined {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
    timeout: 2000
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }
  const commonDir = result.stdout.trim();
  if (!commonDir || path.basename(commonDir) !== ".git") {
    return undefined;
  }
  try {
    return normalizePath(path.dirname(commonDir));
  } catch {
    return undefined;
  }
}

export function sanitizeBrainName(value: string) {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new Error(`Invalid brain name: ${value}`);
  }
  return sanitized;
}

function expandHome(value: string) {
  if (value !== "~" && !value.startsWith("~/")) {
    return value;
  }
  // homedir() falls back to the OS user database when HOME is unset; the old
  // process.env.HOME fallback silently resolved "~/x" to "<cwd>/~/x".
  const home = homedir();
  if (!home) {
    throw new Error(`Cannot expand ${value}: no home directory could be resolved`);
  }
  return value === "~" ? home : path.join(home, value.slice(2));
}

function normalizePath(value: string) {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return resolved;
    }
    throw error;
  }
}

function brainUnavailableMessage(resolution: BrainResolution) {
  if (resolution.unmatched === "ask") {
    return [
      `OpenBrain has no brain configured for this path: ${resolution.cwd}`,
      "Ask the user which brain this path belongs to, then run:",
      `openbrain brain add-path <brain> "${resolution.cwd}"`
    ].join("\n");
  }

  return [
    `OpenBrain is disabled for this path: ${resolution.cwd}`,
    "Add the path to a brain with:",
    `openbrain brain add-path <brain> "${resolution.cwd}"`,
    "Or override for one command with OPENBRAIN_BRAIN=<brain>."
  ].join("\n");
}
