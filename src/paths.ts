import os from "node:os";
import path from "node:path";
import type { OpenBrainOptions } from "./types.js";

export function openBrainHome(options: OpenBrainOptions = {}) {
  return options.home ?? process.env.OPENBRAIN_HOME ?? path.join(os.homedir(), ".openbrain");
}

export function brainName(options: OpenBrainOptions = {}) {
  return options.brain ?? process.env.OPENBRAIN_BRAIN ?? "main";
}

export function brainHome(options: OpenBrainOptions = {}) {
  return path.join(openBrainHome(options), "brains", brainName(options));
}

export function codexHome(options: OpenBrainOptions = {}) {
  return options.codexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

export function claudeHome(options: OpenBrainOptions = {}) {
  return options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
}

export function configPath(options: OpenBrainOptions = {}) {
  return path.join(openBrainHome(options), "config.json");
}

export function updateCheckPath(options: OpenBrainOptions = {}) {
  return path.join(openBrainHome(options), "update-check.json");
}

export function dbPath(options: OpenBrainOptions = {}) {
  return path.join(brainHome(options), "openbrain.db");
}

export function memoriesDir(options: OpenBrainOptions = {}) {
  return path.join(brainHome(options), "memories");
}

export function episodesDir(options: OpenBrainOptions = {}) {
  return path.join(brainHome(options), "episodes");
}

export function dreamsDir(options: OpenBrainOptions = {}) {
  return path.join(brainHome(options), "dreams");
}

export function modelCacheDir(options: OpenBrainOptions = {}) {
  return path.join(openBrainHome(options), "models");
}
