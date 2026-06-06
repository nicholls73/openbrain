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
  const match = config.brains.pathRules
    .flatMap((rule) =>
      rule.paths.map((rulePath) => ({
        brain: rule.brain,
        path: normalizePath(expandHome(rulePath))
      }))
    )
    .filter((rule) => cwd === rule.path || cwd.startsWith(`${rule.path}${path.sep}`))
    .sort((left, right) => right.path.length - left.path.length)[0];

  if (match) {
    return {
      brain: sanitizeBrainName(match.brain),
      enabled: true,
      matchedRule: true,
      unmatched: config.brains.unmatched,
      cwd
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
