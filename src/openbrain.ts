import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrainUnavailableError, canonicalPathForRule, resolveBrain } from "./brains.js";
import { loadConfig, saveConfig, writeDefaultConfig } from "./config.js";
import {
  allRowsWithEmbeddings,
  clearIndex,
  deleteIndexedMemory,
  ftsSearch,
  getMemoryRow,
  listMemoryRows,
  openDatabase,
  upsertMemory
} from "./db.js";
import { createEmbeddingProvider, embedWithTimeout } from "./embeddings.js";
import { brainHome, codexHome, episodesDir, memoriesDir, openBrainHome } from "./paths.js";
import { parseMemoryFile, renderMemoryMarkdown, slugify, titleFromText } from "./markdown.js";
import type {
  AddMemoryInput,
  AddMemoryResult,
  EmbeddingProvider,
  MemoryRecord,
  MemoryType,
  OpenBrainOptions,
  SearchResult
} from "./types.js";

const OPENBRAIN_BEGIN = "<!-- BEGIN OPENBRAIN -->";
const OPENBRAIN_END = "<!-- END OPENBRAIN -->";

export async function initOpenBrain(options: OpenBrainOptions = {}) {
  const { options: scopedOptions } = await prepareOpenBrain(options);
  const db = await openDatabase(scopedOptions);
  db.close();
}

export async function getCurrentBrain(options: OpenBrainOptions = {}) {
  const { resolution } = await prepareOpenBrain(options, { allowUnavailable: true });
  return resolution.enabled ? resolution.brain : `${resolution.unmatched}:${resolution.brain}`;
}

export async function addBrainPath(
  brain: string,
  targetPath: string = process.cwd(),
  options: OpenBrainOptions = {}
) {
  await mkdir(openBrainHome(options), { recursive: true });
  const config = await loadConfig(options);
  const normalizedBrain = brain
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalizedBrain) {
    throw new Error(`Invalid brain name: ${brain}`);
  }

  const canonicalPath = canonicalPathForRule(targetPath);
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
  await saveConfig(config, options);
  return { brain: normalizedBrain, path: canonicalPath };
}

export async function addMemory(
  input: AddMemoryInput,
  options: OpenBrainOptions = {}
): Promise<AddMemoryResult> {
  const { options: scopedOptions } = await prepareOpenBrain(options);
  const now = options.now?.() ?? new Date();
  const title = titleFromText(input.text);
  const id = await uniqueMemoryId(input.type, title, now, scopedOptions);
  const targetDir = input.type === "episode" ? episodesDir(scopedOptions) : memoriesDir(scopedOptions);
  const record: MemoryRecord = {
    id,
    type: input.type,
    title,
    path: path.join(targetDir, `${id}.md`),
    createdAt: now.toISOString(),
    body: input.text.trim()
  };

  await writeFile(record.path, renderMemoryMarkdown(record), "utf8");
  await indexMemoryRecord(record, scopedOptions);
  return record;
}

export async function searchMemories(query: string, options: OpenBrainOptions = {}) {
  const { config, options: scopedOptions } = await prepareOpenBrain(options);
  const db = await openDatabase(scopedOptions);
  try {
    const limit = config.retrieval.limit;
    const ftsRows = ftsSearch(db, toFtsQuery(query), limit);
    const merged = new Map<string, SearchResult>();

    for (const row of ftsRows) {
      merged.set(row.id, {
        id: row.id,
        type: row.type as MemoryType,
        title: row.title,
        path: row.path,
        score: 1 / (1 + Math.abs(row.rank)),
        excerpt: excerpt(row.body, query),
        match: "fts"
      });
    }

    const provider = resolveEmbedder(config, options);
    const queryEmbedding = await embedWithTimeout(provider, query, config.embeddings.timeoutMs);
    if (queryEmbedding) {
      const vectorRows = allRowsWithEmbeddings(db)
        .map((row) => ({
          row,
          score: cosine(queryEmbedding, JSON.parse(row.embedding ?? "[]") as number[])
        }))
        .filter((result) => result.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);

      for (const { row, score } of vectorRows) {
        const existing = merged.get(row.id);
        if (existing) {
          existing.score = Math.max(existing.score, score);
          existing.match = "hybrid";
        } else {
          merged.set(row.id, {
            id: row.id,
            type: row.type as MemoryType,
            title: row.title,
            path: row.path,
            score,
            excerpt: excerpt(row.body, query),
            match: "vector"
          });
        }
      }
    }

    return Array.from(merged.values())
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  } finally {
    db.close();
  }
}

export async function listMemories(options: OpenBrainOptions = {}) {
  const { options: scopedOptions } = await prepareOpenBrain(options);
  const db = await openDatabase(scopedOptions);
  try {
    return listMemoryRows(db).map(rowToMemoryRecord);
  } finally {
    db.close();
  }
}

export async function showMemory(id: string, options: OpenBrainOptions = {}) {
  const { options: scopedOptions } = await prepareOpenBrain(options);
  const db = await openDatabase(scopedOptions);
  try {
    const row = getMemoryRow(db, id);
    if (!row) {
      throw new Error(`Memory not found: ${id}`);
    }
    return readFile(row.path, "utf8");
  } finally {
    db.close();
  }
}

export async function deleteMemory(id: string, options: OpenBrainOptions = {}) {
  const { options: scopedOptions } = await prepareOpenBrain(options);
  const db = await openDatabase(scopedOptions);
  try {
    const row = getMemoryRow(db, id);
    if (!row) {
      throw new Error(`Memory not found: ${id}`);
    }
    await rm(row.path, { force: true });
    deleteIndexedMemory(db, id);
  } finally {
    db.close();
  }
}

export async function rebuildIndex(options: OpenBrainOptions = {}) {
  const { options: scopedOptions } = await prepareOpenBrain(options);
  const db = await openDatabase(scopedOptions);
  try {
    clearIndex(db);
  } finally {
    db.close();
  }

  for (const filePath of await memoryFiles(scopedOptions)) {
    const record = await parseMemoryFile(filePath);
    await indexMemoryRecord(record, scopedOptions);
  }
}

export async function pruneEpisodes(options: OpenBrainOptions = {}) {
  const { config, options: scopedOptions } = await prepareOpenBrain(options);
  const cutoff = (options.now?.() ?? new Date()).getTime() - config.retentionDays * 24 * 60 * 60 * 1000;
  const pruned: string[] = [];
  const db = await openDatabase(scopedOptions);
  try {
    for (const filePath of await markdownFiles(episodesDir(scopedOptions))) {
      const stats = await stat(filePath);
      if (episodeTimestamp(filePath, stats.mtime) < cutoff) {
        const row = listMemoryRows(db).find((memory) => memory.path === filePath);
        await rm(filePath, { force: true });
        if (row) {
          deleteIndexedMemory(db, row.id);
        }
        pruned.push(filePath);
      }
    }
  } finally {
    db.close();
  }
  return pruned;
}

export async function syncCodexAgent(options: OpenBrainOptions = {}) {
  await initOpenBrain(options);
  const dir = codexHome(options);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "AGENTS.md");
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

async function indexMemoryRecord(record: MemoryRecord, options: OpenBrainOptions) {
  const config = await loadConfig(options);
  const provider = resolveEmbedder(config, options);
  const embedding = await embedWithTimeout(provider, `${record.title}\n\n${record.body}`, config.embeddings.timeoutMs);
  const db = await openDatabase(options);
  try {
    upsertMemory(db, record, embedding);
  } finally {
    db.close();
  }
}

async function prepareOpenBrain(
  options: OpenBrainOptions = {},
  behavior: { allowUnavailable?: boolean } = {}
) {
  await mkdir(openBrainHome(options), { recursive: true });
  const config = await loadConfig(options);
  const resolution = resolveBrain(config, options);
  if (!resolution.enabled && !behavior.allowUnavailable) {
    throw new BrainUnavailableError(resolution);
  }
  const scopedOptions = {
    ...options,
    brain: resolution.brain
  };
  await mkdir(brainHome(scopedOptions), { recursive: true });
  await mkdir(memoriesDir(scopedOptions), { recursive: true });
  await mkdir(episodesDir(scopedOptions), { recursive: true });
  return { config, options: scopedOptions, resolution };
}

function resolveEmbedder(config: Awaited<ReturnType<typeof loadConfig>>, options: OpenBrainOptions) {
  if (options.embedder) {
    return options.embedder;
  }
  return createEmbeddingProvider(config, options);
}

async function uniqueMemoryId(
  type: MemoryType,
  title: string,
  now: Date,
  options: OpenBrainOptions
) {
  const date = now.toISOString().slice(0, 10);
  const base = `${date}-${slugify(title) || type}`;
  const targetDir = type === "episode" ? episodesDir(options) : memoriesDir(options);
  let candidate = base;
  let suffix = 2;
  while (await exists(path.join(targetDir, `${candidate}.md`))) {
    candidate = `${base}-${suffix++}`;
  }
  return candidate;
}

async function exists(filePath: string) {
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

async function memoryFiles(options: OpenBrainOptions) {
  return [...(await markdownFiles(memoriesDir(options))), ...(await markdownFiles(episodesDir(options)))];
}

async function markdownFiles(dir: string): Promise<string[]> {
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

function rowToMemoryRecord(row: {
  id: string;
  type: string;
  title: string;
  path: string;
  created_at: string;
  body: string;
}) {
  return {
    id: row.id,
    type: row.type as MemoryType,
    title: row.title,
    path: row.path,
    createdAt: row.created_at,
    body: row.body
  };
}

function toFtsQuery(query: string) {
  return query
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.map((token) => `${token}*`)
    .join(" OR ") ?? "";
}

function excerpt(body: string, query: string) {
  const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const lowerBody = body.toLowerCase();
  const firstMatch = words.map((word) => lowerBody.indexOf(word)).filter((index) => index >= 0).sort()[0] ?? 0;
  const start = Math.max(0, firstMatch - 60);
  const value = body.slice(start, start + 220).replace(/\s+/g, " ").trim();
  return start > 0 ? `...${value}` : value;
}

function cosine(left: number[], right: number[]) {
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

function episodeTimestamp(filePath: string, fallback: Date) {
  const match = path.basename(filePath).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? new Date(`${match[1]}T00:00:00.000Z`).getTime() : fallback.getTime();
}

function codexBlock() {
  return `${OPENBRAIN_BEGIN}
## OpenBrain Memory

OpenBrain selects a separate brain from the current working directory using
\`~/.openbrain/config.json\`. Work and personal project paths should map to
different brains so their memories do not leak into each other.

If OpenBrain reports that the current path is not assigned to a brain, ask the
user which brain should own the path, then run:

\`\`\`bash
openbrain brain add-path <brain> "<current project path>"
\`\`\`

Before starting a task, run:

\`\`\`bash
openbrain memory search "<short description of the user's current task>"
\`\`\`

Use only relevant returned memories.

After meaningful work, record concise durable memories:

\`\`\`bash
openbrain memory add --type workflow --text "..."
openbrain memory add --type project --text "..."
openbrain memory add --type preference --text "..."
openbrain memory add --type decision --text "..."
openbrain memory add --type episode --text "..."
\`\`\`

Use memory types this way:
- \`preference\`: user preferences.
- \`workflow\`: repeated process knowledge.
- \`project\`: repo or tooling conventions.
- \`decision\`: durable decisions.
- \`episode\`: short-lived session notes.

Never store secrets, credentials, sensitive personal details, or temporary one-off facts.
${OPENBRAIN_END}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
