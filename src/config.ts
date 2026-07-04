import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { configPath } from "./paths.js";
import type { OpenBrainConfig, OpenBrainOptions } from "./types.js";

// Config mutations are millisecond-scale, so a lock older than the stale
// threshold was leaked by a crashed process and can be taken over.
const CONFIG_LOCK_STALE_MS = 10_000;
const CONFIG_LOCK_WAIT_MS = 5_000;

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
    timeoutMs: 5000,
    loadTimeoutMs: 30000
  },
  retrieval: {
    limit: 5
  },
  agents: {
    codex: {
      enabled: true
    },
    claude: {
      enabled: true
    }
  }
};

export async function writeDefaultConfig(options: OpenBrainOptions = {}) {
  const config = defaultConfig();
  await saveConfig(config, options);
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
  // Write-then-rename so a concurrent reader never observes a torn file.
  const temp = `${file}.${process.pid}-${saveCounter++}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await rename(temp, file);
}

let saveCounter = 0;

// Serialise read-modify-write cycles on config.json. OpenBrain is shared by
// every coding agent on the machine, so two processes can mutate the config
// concurrently; without the lock, the later save silently drops the earlier
// one's changes.
export async function updateConfig(
  mutate: (config: OpenBrainConfig) => void,
  options: OpenBrainOptions = {}
): Promise<OpenBrainConfig> {
  const releaseLock = await acquireConfigLock(options);
  try {
    const config = await loadConfig(options);
    mutate(config);
    await saveConfig(config, options);
    return config;
  } finally {
    await releaseLock();
  }
}

// mkdir of the lock directory is atomic across processes. Waiters poll until
// the holder releases, taking over locks past the stale threshold.
async function acquireConfigLock(options: OpenBrainOptions) {
  const lockPath = `${configPath(options)}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { recursive: false });
      return () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const stats = await stat(lockPath).catch(() => undefined);
      if (stats && Date.now() - stats.mtime.getTime() > CONFIG_LOCK_STALE_MS) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the OpenBrain config lock: ${lockPath}`);
      }
      await delay(25);
    }
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      },
      claude: {
        ...defaults.agents.claude,
        ...raw.agents?.claude
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
      },
      claude: {
        ...DEFAULT_CONFIG.agents.claude
      }
    }
  };
}
