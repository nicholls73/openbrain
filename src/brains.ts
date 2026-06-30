import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
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
  inheritedPath?: string;
  inheritedFrom?: string;
  ambiguousWorktree?: boolean;
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
  const pathRules = normalizedPathRules(config);
  const match = mostSpecificPathRule(pathRules, cwd);

  if (match) {
    return {
      brain: sanitizeBrainName(match.brain),
      enabled: true,
      matchedRule: true,
      unmatched: config.brains.unmatched,
      cwd
    };
  }

  const inherited = worktreeInheritance(pathRules, cwd);
  if (inherited.status === "inherited") {
    return {
      brain: sanitizeBrainName(inherited.brain),
      enabled: true,
      matchedRule: true,
      unmatched: config.brains.unmatched,
      cwd,
      inheritedPath: inherited.worktreePath,
      inheritedFrom: inherited.sourcePath
    };
  }

  if (inherited.status === "ambiguous") {
    return {
      brain: sanitizeBrainName(config.brains.default ?? DEFAULT_BRAIN),
      enabled: false,
      matchedRule: false,
      unmatched: "ask",
      cwd,
      ambiguousWorktree: true
    };
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

interface NormalizedPathRule {
  brain: string;
  path: string;
}

interface WorktreeRelationship {
  sourcePath: string;
  worktreePath: string;
}

function normalizedPathRules(config: OpenBrainConfig): NormalizedPathRule[] {
  return config.brains.pathRules.flatMap((rule) =>
    rule.paths.map((rulePath) => ({
      brain: rule.brain,
      path: normalizePath(expandHome(rulePath))
    }))
  );
}

function mostSpecificPathRule(rules: NormalizedPathRule[], cwd: string) {
  return rules
    .filter((rule) => cwd === rule.path || cwd.startsWith(`${rule.path}${path.sep}`))
    .sort((left, right) => right.path.length - left.path.length)[0];
}

function worktreeInheritance(
  rules: NormalizedPathRule[],
  cwd: string
): { status: "none" } | { status: "ambiguous" } | ({ status: "inherited" } & WorktreeRelationship & { brain: string }) {
  const relationship = findWorktreeRelationship(cwd);
  if (!relationship) {
    return { status: "none" };
  }

  const candidates = rules
    .filter((rule) => relationship.sourcePath === rule.path || relationship.sourcePath.startsWith(`${rule.path}${path.sep}`))
    .sort((left, right) => right.path.length - left.path.length);
  if (candidates.length === 0) {
    return { status: "none" };
  }

  const longest = candidates[0]!.path.length;
  const mostSpecific = candidates.filter((candidate) => candidate.path.length === longest);
  const brains = new Set(mostSpecific.map((candidate) => sanitizeBrainName(candidate.brain)));
  if (brains.size > 1) {
    return { status: "ambiguous" };
  }

  return {
    status: "inherited",
    brain: mostSpecific[0]!.brain,
    sourcePath: relationship.sourcePath,
    worktreePath: relationship.worktreePath
  };
}

function findWorktreeRelationship(cwd: string): WorktreeRelationship | undefined {
  const topLevel = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) {
    return undefined;
  }

  const worktreeList = git(cwd, ["worktree", "list", "--porcelain"]);
  if (!worktreeList) {
    return undefined;
  }

  const worktrees = worktreeList
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => normalizePath(line.slice("worktree ".length).trim()))
    .filter(Boolean);
  if (worktrees.length < 2) {
    return undefined;
  }

  const worktreePath = normalizePath(topLevel);
  const sourcePath = worktrees[0];
  if (!sourcePath || sourcePath === worktreePath) {
    return undefined;
  }

  return { sourcePath, worktreePath };
}

function git(cwd: string, args: string[]) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
}

export function canonicalPathForRule(value: string) {
  return normalizePath(expandHome(value));
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
  if (value === "~") {
    return process.env.HOME ?? value;
  }
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME ?? "~", value.slice(2));
  }
  return value;
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
  if (resolution.ambiguousWorktree) {
    return [
      `OpenBrain found multiple possible brain mappings for this worktree path: ${resolution.cwd}`,
      "Ask the user which brain this path belongs to, then run:",
      `openbrain brain add-path <brain> "${resolution.cwd}"`
    ].join("\n");
  }

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
