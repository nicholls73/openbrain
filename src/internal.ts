import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { BrainUnavailableError, resolveBrain } from "./brains.js";
import { loadConfig } from "./config.js";
import { openDatabase, upsertMemory } from "./db.js";
import { createEmbeddingProvider, embedWithTimeout } from "./embeddings.js";
import { memoryMetadataDefaults } from "./markdown.js";
import { brainHome, dreamsDir, episodesDir, memoriesDir, openBrainHome } from "./paths.js";
import type {
  BrainStatus,
  EmbeddingProvider,
  MemoryRecord,
  OpenBrainConfig,
  OpenBrainOptions
} from "./types.js";

// New durable memories at or above this cosine similarity to an existing
// memory of the same type are flagged as likely duplicates. The memory is
// still written; the notice nudges the caller towards memory update instead.
export const DUPLICATE_SIMILARITY = 0.9;

export async function initOpenBrain(options: OpenBrainOptions = {}) {
  const { options: scopedOptions } = await prepareOpenBrain(options);
  const db = await openDatabase(scopedOptions);
  db.close();
}

export async function getBrainStatus(options: OpenBrainOptions = {}): Promise<BrainStatus> {
  const { resolution } = await prepareOpenBrain(options, { allowUnavailable: true });
  if (resolution.enabled) {
    return { brain: resolution.brain, state: "active" };
  }
  return { brain: resolution.brain, state: resolution.unmatched === "ask" ? "ask" : "disabled" };
}

// Human/CLI-facing rendering of getBrainStatus. Programmatic callers should
// use getBrainStatus instead of parsing this string.
export async function getCurrentBrain(options: OpenBrainOptions = {}) {
  const status = await getBrainStatus(options);
  return status.state === "active" ? status.brain : `${status.state}:${status.brain}`;
}

export async function prepareOpenBrain(
  options: OpenBrainOptions = {},
  behavior: { allowUnavailable?: boolean; readonly?: boolean } = {}
) {
  // Read-only commands skip directory creation so they work in sandboxes
  // that can read the store but not write to it. The directories only need
  // to exist before something is written, and every write path creates them.
  if (!behavior.readonly) {
    await mkdir(openBrainHome(options), { recursive: true });
  }
  const config = await loadConfig(options);
  const resolution = resolveBrain(config, options);
  if (!resolution.enabled && !behavior.allowUnavailable) {
    throw new BrainUnavailableError(resolution);
  }
  const scopedOptions = {
    ...options,
    brain: resolution.brain
  };
  if (!behavior.readonly) {
    await mkdir(brainHome(scopedOptions), { recursive: true });
    await mkdir(memoriesDir(scopedOptions), { recursive: true });
    await mkdir(episodesDir(scopedOptions), { recursive: true });
    await mkdir(dreamsDir(scopedOptions), { recursive: true });
  }
  return { config, options: scopedOptions, resolution };
}

export interface IndexEntry {
  record: MemoryRecord;
  embedding: number[] | Buffer | null;
}

export async function prepareIndexEntry(
  record: MemoryRecord,
  config: OpenBrainConfig,
  provider: EmbeddingProvider
): Promise<IndexEntry> {
  const normalized = {
    ...record,
    metadata: memoryMetadataDefaults(record.type, record.createdAt, config.retentionDays, record.metadata)
  };
  const embedding =
    normalized.metadata.sensitivity === "private"
      ? null
      : await embedWithTimeout(
          provider,
          `${normalized.title}\n\n${normalized.body}`,
          config.embeddings.timeoutMs,
          config.embeddings.loadTimeoutMs
        );
  return { record: normalized, embedding };
}

export async function indexMemoryRecord(
  record: MemoryRecord,
  options: OpenBrainOptions,
  context: { config?: OpenBrainConfig; provider?: EmbeddingProvider } = {}
) {
  const config = context.config ?? (await loadConfig(options));
  const provider = context.provider ?? resolveEmbedder(config, options);
  const entry = await prepareIndexEntry(record, config, provider);
  const db = await openDatabase(options);
  try {
    upsertMemory(db, entry.record, entry.embedding);
  } finally {
    db.close();
  }
}

export function resolveEmbedder(config: Awaited<ReturnType<typeof loadConfig>>, options: OpenBrainOptions) {
  if (options.embedder) {
    return options.embedder;
  }
  return createEmbeddingProvider(config, options);
}

export async function memoryFiles(options: OpenBrainOptions) {
  return [...(await markdownFiles(memoriesDir(options))), ...(await markdownFiles(episodesDir(options)))];
}

export async function markdownFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          return markdownFiles(entryPath);
        }
        return entry.isFile() && entry.name.endsWith(".md") ? [entryPath] : [];
      })
    );
    return nested.flat();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function exists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function cosine(left: ArrayLike<number>, right: ArrayLike<number>) {
  if (!left.length || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  if (!leftNorm || !rightNorm) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function excerpt(body: string, query: string) {
  const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const lowerBody = body.toLowerCase();
  const matchIndexes = words.map((word) => lowerBody.indexOf(word)).filter((index) => index >= 0);
  const firstMatch = matchIndexes.length ? Math.min(...matchIndexes) : 0;
  const start = Math.max(0, firstMatch - 60);
  const value = body
    .slice(start, start + 220)
    .replace(/\s+/g, " ")
    .trim();
  return start > 0 ? `...${value}` : value;
}
