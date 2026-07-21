import { mkdir } from "node:fs/promises";
import {
  detectClaudeAgent,
  detectCodexAgent,
  disableClaudeAutoMemory,
  syncClaudeAgent,
  syncCodexAgent
} from "./adapters.js";
import { canonicalPathForRule } from "./brains.js";
import { updateConfig } from "./config.js";
import { getCurrentBrain, initOpenBrain } from "./internal.js";
import { claudeSettingsPath, openBrainHome } from "./paths.js";
import type { OpenBrainOptions, SetupInput, SetupResult } from "./types.js";

export async function setupOpenBrain(
  input: SetupInput,
  options: OpenBrainOptions = {}
): Promise<SetupResult> {
  await mkdir(openBrainHome(options), { recursive: true });
  const pathRules: SetupResult["pathRules"] = [];

  const codexDetected = await detectCodexAgent(options);
  const claudeDetected = await detectClaudeAgent(options);
  const syncCodex = input.syncCodex ?? codexDetected;
  const syncClaude = input.syncClaude ?? claudeDetected;

  if (input.brainScope === "default") {
    const config = await updateConfig((config) => {
      config.brains.unmatched = "default";
      config.brains.pathRules = [];
      config.agents.codex.enabled = syncCodex;
      config.agents.claude.enabled = syncClaude;
    }, options);
    await initOpenBrain({ ...options, brain: config.brains.default });
  } else {
    if (!input.pathRules?.length) {
      throw new Error("setup with path-specific brains requires at least one path rule");
    }
    await updateConfig((config) => {
      config.brains.unmatched = "ask";
      config.brains.pathRules = [];
      config.agents.codex.enabled = syncCodex;
      config.agents.claude.enabled = syncClaude;
    }, options);

    for (const rule of input.pathRules) {
      const added = await addBrainPath(rule.brain, rule.path, options);
      pathRules.push(added);
      await initOpenBrain({ ...options, brain: added.brain });
    }
  }

  const codexAgentFile = syncCodex ? await syncCodexAgent(options) : undefined;
  const claudeAgentFile = syncClaude ? await syncClaudeAgent(options) : undefined;
  if (syncClaude && input.disableClaudeAutoMemory) {
    await disableClaudeAutoMemory(options);
  }
  const currentBrain =
    input.brainScope === "paths"
      ? await getCurrentBrain({ ...options, cwd: pathRules[0]!.path })
      : await getCurrentBrain(options);

  return {
    brainScope: input.brainScope,
    currentBrain,
    pathRules,
    codexDetected,
    claudeDetected,
    codexAgentFile,
    claudeAgentFile,
    claudeSettingsFile: syncClaude ? claudeSettingsPath(options) : undefined
  };
}

export async function addBrainPath(
  brain: string,
  targetPath: string = process.cwd(),
  options: OpenBrainOptions = {}
) {
  await mkdir(openBrainHome(options), { recursive: true });
  const normalizedBrain = brain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalizedBrain) {
    throw new Error(`Invalid brain name: ${brain}`);
  }

  const canonicalPath = canonicalPathForRule(targetPath);
  await updateConfig((config) => {
    const existing = config.brains.pathRules.find((rule) => rule.brain === normalizedBrain);
    if (existing) {
      if (!existing.paths.includes(canonicalPath)) {
        existing.paths.push(canonicalPath);
      }
    } else {
      config.brains.pathRules.push({
        brain: normalizedBrain,
        paths: [canonicalPath]
      });
    }
  }, options);
  return { brain: normalizedBrain, path: canonicalPath };
}
