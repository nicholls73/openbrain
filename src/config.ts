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
  const config = defaultConfig();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
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
  const defaults = defaultConfig();
  return {
    ...defaults,
    ...raw,
    brains: {
      ...defaults.brains,
      ...raw.brains,
      pathRules: raw.brains?.pathRules ?? defaults.brains.pathRules
    },
    embeddings: {
      ...defaults.embeddings,
      ...raw.embeddings
    },
    retrieval: {
      ...defaults.retrieval,
      ...raw.retrieval
    },
    agents: {
      ...defaults.agents,
      ...raw.agents,
      codex: {
        ...defaults.agents.codex,
        ...raw.agents?.codex
      }
    }
  };
}

function defaultConfig(): OpenBrainConfig {
  return {
    ...DEFAULT_CONFIG,
    brains: {
      ...DEFAULT_CONFIG.brains,
      pathRules: [...DEFAULT_CONFIG.brains.pathRules]
    },
    embeddings: {
      ...DEFAULT_CONFIG.embeddings
    },
    retrieval: {
      ...DEFAULT_CONFIG.retrieval
    },
    agents: {
      codex: {
        ...DEFAULT_CONFIG.agents.codex
      }
    }
  };
}
