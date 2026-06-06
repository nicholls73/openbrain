import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configPath } from "./paths.js";
import type { OpenBrainConfig, OpenBrainOptions } from "./types.js";

export const DEFAULT_CONFIG: OpenBrainConfig = {
  version: 1,
  retentionDays: 30,
  brains: {
    default: "main",
    unmatched: "default",
    pathRules: []
  },
  embeddings: {
    enabled: true,
    model: "sentence-transformers/all-MiniLM-L6-v2",
    dimensions: 384,
    timeoutMs: 5000
  },
  retrieval: {
    limit: 5
  },
  agents: {
    codex: {
      enabled: true
    }
  }
};

export async function writeDefaultConfig(options: OpenBrainOptions = {}) {
  const file = configPath(options);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
  return DEFAULT_CONFIG;
}

export async function loadConfig(options: OpenBrainOptions = {}) {
  try {
    const raw = await readFile(configPath(options), "utf8");
    return mergeConfig(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return writeDefaultConfig(options);
  }
}

export async function saveConfig(config: OpenBrainConfig, options: OpenBrainOptions = {}) {
  const file = configPath(options);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function mergeConfig(raw: Partial<OpenBrainConfig>): OpenBrainConfig {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    brains: {
      ...DEFAULT_CONFIG.brains,
      ...raw.brains,
      pathRules: raw.brains?.pathRules ?? DEFAULT_CONFIG.brains.pathRules
    },
    embeddings: {
      ...DEFAULT_CONFIG.embeddings,
      ...raw.embeddings
    },
    retrieval: {
      ...DEFAULT_CONFIG.retrieval,
      ...raw.retrieval
    },
    agents: {
      ...DEFAULT_CONFIG.agents,
      ...raw.agents,
      codex: {
        ...DEFAULT_CONFIG.agents.codex,
        ...raw.agents?.codex
      }
    }
  };
}
