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
import type { IndexedMemoryRow } from "./db.js";
import { createEmbeddingProvider, embedWithTimeout } from "./embeddings.js";
import { brainHome, codexHome, dreamsDir, episodesDir, memoriesDir, openBrainHome } from "./paths.js";
import {
  memoryMetadataDefaults,
  parseMemoryFile,
  renderMemoryMarkdown,
  slugify,
  titleFromText
} from "./markdown.js";
import type {
  AddMemoryInput,
  AddMemoryResult,
  DurableMemoryType,
  DreamResult,
  DreamRunResult,
  EmbeddingProvider,
  MemoryRecord,
  MemoryType,
  OpenBrainOptions,
  PromoteMemoryInput,
  SearchMemoriesOptions,
  SetupInput,
  SetupResult,
  StoredMemoryType,
  SearchResult
} from "./types.js";

const OPENBRAIN_BEGIN = "<!-- BEGIN OPENBRAIN -->";
const OPENBRAIN_END = "<!-- END OPENBRAIN -->";

export async function initOpenBrain(options: OpenBrainOptions = {}) {
  const { options: scopedOptions } = await prepareOpenBrain(options);
  const db = await openDatabase(scopedOptions);
  db.close();
}

export async function setupOpenBrain(
  input: SetupInput,
  options: OpenBrainOptions = {}
): Promise<SetupResult> {
  await mkdir(openBrainHome(options), { recursive: true });
  const config = await loadConfig(options);
  let pathRules: SetupResult["pathRules"] = [];

  if (input.brainScope === "default") {
    config.brains.unmatched = "default";
    config.brains.pathRules = [];
    await saveConfig(config, options);
    await initOpenBrain({ ...options, brain: config.brains.default });
  } else {
    if (!input.pathRules?.length) {
      throw new Error("setup with path-specific brains requires at least one path rule");
    }
    config.brains.unmatched = "ask";
    config.brains.pathRules = [];
    await saveConfig(config, options);

    for (const rule of input.pathRules) {
      const added = await addBrainPath(rule.brain, rule.path, options);
      pathRules.push(added);
      await initOpenBrain({ ...options, brain: added.brain });
    }
  }

  const codexAgentFile = input.syncCodex ? await syncCodexAgent(options) : undefined;
  const currentBrain =
    input.brainScope === "paths"
      ? await getCurrentBrain({ ...options, cwd: pathRules[0]!.path })
      : await getCurrentBrain(options);

  return {
    brainScope: input.brainScope,
    currentBrain,
    pathRules,
    codexAgentFile
  };
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
  const { config, options: scopedOptions } = await prepareOpenBrain(options);
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
    body: input.text.trim(),
    metadata: memoryMetadataDefaults(input.type, now.toISOString(), config.retentionDays, input.metadata)
  };

  await writeFile(record.path, renderMemoryMarkdown(record), "utf8");
  await indexMemoryRecord(record, scopedOptions);
  return record;
}

export async function promoteMemory(input: PromoteMemoryInput, options: OpenBrainOptions = {}) {
  const { options: scopedOptions } = await prepareOpenBrain(options);
  const db = await openDatabase(scopedOptions);
  let episode: IndexedMemoryRow;
  try {
    const row = getMemoryRow(db, input.episodeId);
    if (!row) {
      throw new Error(`Memory not found: ${input.episodeId}`);
    }
    if (row.type !== "episode") {
      throw new Error(`Memory is not an episode: ${input.episodeId}`);
    }
    episode = row;
  } finally {
    db.close();
  }

  return addMemory(
    {
      type: input.type,
      text: input.text,
      metadata: {
        source: episode.source,
        promotedFrom: episode.id,
        sensitivity: episode.sensitivity === "private" ? "private" : "standard"
      }
    },
    scopedOptions
  );
}

export async function searchMemories(query: string, options: SearchMemoriesOptions = {}) {
  const { config, options: scopedOptions } = await prepareOpenBrain(options);
  const db = await openDatabase(scopedOptions);
  try {
    const limit = config.retrieval.limit;
    const searchLimit = limit * 20;
    const now = options.now?.() ?? new Date();

    // Reciprocal Rank Fusion combines the FTS and vector result lists by their
    // rank position, not by their raw scores. bm25 ranks and cosine similarity
    // live on different, incomparable scales, so a raw-score merge let whichever
    // scale ran larger dominate regardless of relevance.
    const RRF_K = 60;
    const fused = new Map<
      string,
      { row: IndexedMemoryRow; score: number; matches: Set<"fts" | "vector"> }
    >();

    const fuse = (rows: IndexedMemoryRow[], match: "fts" | "vector") => {
      rows.forEach((row, index) => {
        const contribution = 1 / (RRF_K + index + 1);
        const existing = fused.get(row.id);
        if (existing) {
          existing.score += contribution;
          existing.matches.add(match);
        } else {
          fused.set(row.id, { row, score: contribution, matches: new Set([match]) });
        }
      });
    };

    const filterRows = (rows: IndexedMemoryRow[]) =>
      rows.filter((row) => rowMatchesSearchOptions(row, options, now));

    fuse(filterRows(ftsSearch(db, toFtsQuery(query), searchLimit)).slice(0, limit), "fts");

    const provider = resolveEmbedder(config, options);
    const queryEmbedding = await embedWithTimeout(provider, query, config.embeddings.timeoutMs);
    if (queryEmbedding) {
      // Stored embeddings whose length differs from the current model's output
      // can never match (cosine returns 0). That used to be silent, so swapping
      // the embedding model quietly disabled semantic search for every existing
      // memory. Skip those rows explicitly and tell the user to re-embed.
      let dimensionMismatches = 0;
      const vectorRows = allRowsWithEmbeddings(db)
        .filter((row) => rowMatchesSearchOptions(row, options, now))
        .map((row) => ({ row, embedding: JSON.parse(row.embedding ?? "[]") as number[] }))
        .filter(({ embedding }) => {
          if (embedding.length !== queryEmbedding.length) {
            dimensionMismatches += 1;
            return false;
          }
          return true;
        })
        .map(({ row, embedding }) => ({ row, score: cosine(queryEmbedding, embedding) }))
        .filter((result) => result.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map((result) => result.row);

      if (dimensionMismatches > 0) {
        console.warn(
          `openbrain: skipped ${dimensionMismatches} memor${dimensionMismatches === 1 ? "y" : "ies"} ` +
            `with embeddings that no longer match the current model (${queryEmbedding.length} dims). ` +
            `Run "openbrain index rebuild" to re-embed them.`
        );
      }

      fuse(vectorRows, "vector");
    }

    return Array.from(fused.values())
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ row, score, matches }): SearchResult => ({
        id: row.id,
        type: row.type as StoredMemoryType,
        title: row.title,
        path: row.path,
        source: row.source,
        scope: row.scope,
        confidence: row.confidence as SearchResult["confidence"],
        expiresAt: row.expires_at ?? undefined,
        promotedFrom: row.promoted_from ?? undefined,
        sensitivity: row.sensitivity as SearchResult["sensitivity"],
        promoteAs: (row.promote_as ?? undefined) as SearchResult["promoteAs"],
        score,
        excerpt: excerpt(row.body, query),
        match: matches.size > 1 ? "hybrid" : ([...matches][0] as "fts" | "vector")
      }));
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
  const { config, options: scopedOptions } = await prepareOpenBrain(options);
  const db = await openDatabase(scopedOptions);
  try {
    clearIndex(db);
  } finally {
    db.close();
  }

  // Build the embedder once and reuse it for every file. Creating a provider
  // per file would reload the local embedding model on each iteration.
  const provider = resolveEmbedder(config, scopedOptions);
  for (const filePath of await memoryFiles(scopedOptions)) {
    const record = await parseMemoryFile(filePath, config.retentionDays);
    await indexMemoryRecord(record, scopedOptions, { config, provider });
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

export async function dreamMaybe(options: OpenBrainOptions = {}): Promise<DreamResult> {
  const { options: scopedOptions, resolution } = await prepareOpenBrain(options);
  const now = options.now?.() ?? new Date();
  const date = localDateString(now);
  const state = await readDreamState(scopedOptions);
  if (state.lastDreamDate === date) {
    return {
      brain: resolution.brain,
      status: "skipped",
      date,
      reason: "already-dreamed-today"
    };
  }

  return runDreamWithLock(scopedOptions, resolution.brain, now, async () => {
    const freshState = await readDreamState(scopedOptions);
    if (freshState.lastDreamDate === date) {
      return {
        brain: resolution.brain,
        status: "skipped",
        date,
        reason: "already-dreamed-today"
      };
    }
    return performDream(scopedOptions, resolution.brain, now);
  });
}

export async function dreamRun(options: OpenBrainOptions = {}): Promise<DreamResult> {
  const { options: scopedOptions, resolution } = await prepareOpenBrain(options);
  const now = options.now?.() ?? new Date();
  return runDreamWithLock(scopedOptions, resolution.brain, now, () => performDream(scopedOptions, resolution.brain, now));
}

export async function syncCodexAgent(options: OpenBrainOptions = {}) {
  const config = await loadConfig(options);
  await initOpenBrain({ ...options, brain: config.brains.default });
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

async function indexMemoryRecord(
  record: MemoryRecord,
  options: OpenBrainOptions,
  context: { config?: Awaited<ReturnType<typeof loadConfig>>; provider?: EmbeddingProvider } = {}
) {
  const config = context.config ?? (await loadConfig(options));
  const provider = context.provider ?? resolveEmbedder(config, options);
  const normalized = {
    ...record,
    metadata: memoryMetadataDefaults(record.type, record.createdAt, config.retentionDays, record.metadata)
  };
  const embedding =
    normalized.metadata.sensitivity === "private"
      ? null
      : await embedWithTimeout(provider, `${normalized.title}\n\n${normalized.body}`, config.embeddings.timeoutMs);
  const db = await openDatabase(options);
  try {
    upsertMemory(db, normalized, embedding);
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
  await mkdir(dreamsDir(scopedOptions), { recursive: true });
  return { config, options: scopedOptions, resolution };
}

async function runDreamWithLock(
  options: OpenBrainOptions,
  brain: string,
  now: Date,
  run: () => Promise<DreamResult>
): Promise<DreamResult> {
  const date = localDateString(now);
  const lockPath = path.join(dreamsDir(options), ".lock");
  const acquired = await acquireDreamLock(lockPath, now);
  if (!acquired) {
    return {
      brain,
      status: "skipped",
      date,
      reason: "dream-already-running"
    };
  }

  try {
    return await run();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function acquireDreamLock(lockPath: string, now: Date): Promise<boolean> {
  try {
    await mkdir(lockPath, { recursive: false });
    await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({ createdAt: now.toISOString() }, null, 2)}\n`, "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }

    const stats = await stat(lockPath).catch(() => undefined);
    if (stats && now.getTime() - stats.mtime.getTime() > 30 * 60 * 1000) {
      await rm(lockPath, { recursive: true, force: true });
      return acquireDreamLock(lockPath, now);
    }
    return false;
  }
}

async function performDream(options: OpenBrainOptions, brain: string, now: Date): Promise<DreamRunResult> {
  const date = localDateString(now);
  const config = await loadConfig(options);
  const pruned = await pruneEpisodes(options);
  await rebuildIndex(options);
  const promotionCandidatesPath = await writePromotionCandidates(date, now, options, config.retentionDays);
  const logPath = await uniqueDreamLogPath(date, now, options);
  const result: DreamRunResult = {
    brain,
    status: "ran",
    date,
    prunedEpisodes: pruned.length,
    rebuiltIndex: true,
    logPath,
    promotionCandidatesPath
  };
  await writeFile(logPath, renderDreamLog(result, now), "utf8");
  await writeDreamState(
    {
      lastDreamAt: now.toISOString(),
      lastDreamDate: date,
      lastLogPath: logPath
    },
    options
  );
  return result;
}

async function readDreamState(options: OpenBrainOptions) {
  try {
    return JSON.parse(await readFile(dreamStatePath(options), "utf8")) as {
      lastDreamAt?: string;
      lastDreamDate?: string;
      lastLogPath?: string;
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeDreamState(
  state: { lastDreamAt: string; lastDreamDate: string; lastLogPath: string },
  options: OpenBrainOptions
) {
  await mkdir(dreamsDir(options), { recursive: true });
  await writeFile(dreamStatePath(options), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function dreamStatePath(options: OpenBrainOptions) {
  return path.join(dreamsDir(options), "state.json");
}

async function uniqueDreamLogPath(date: string, now: Date, options: OpenBrainOptions) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const base = path.join(dreamsDir(options), `${date}-${timestamp}-dream`);
  let candidate = `${base}.md`;
  let suffix = 2;
  while (await exists(candidate)) {
    candidate = `${base}-${suffix++}.md`;
  }
  return candidate;
}

async function uniquePromotionCandidatesPath(date: string, now: Date, options: OpenBrainOptions) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const base = path.join(dreamsDir(options), `${date}-${timestamp}-promotion-candidates`);
  let candidate = `${base}.md`;
  let suffix = 2;
  while (await exists(candidate)) {
    candidate = `${base}-${suffix++}.md`;
  }
  return candidate;
}

function renderDreamLog(result: DreamRunResult, now: Date) {
  return [
    "# Dream run",
    "",
    `- brain: ${result.brain}`,
    `- date: ${result.date}`,
    `- ranAt: ${now.toISOString()}`,
    `- prunedEpisodes: ${result.prunedEpisodes}`,
    `- rebuiltIndex: ${result.rebuiltIndex}`,
    `- promotionCandidates: ${result.promotionCandidatesPath ?? "none"}`,
    "",
    "Maintenance performed:",
    "",
    "- Pruned expired episode files.",
    "- Rebuilt the SQLite retrieval index from Markdown.",
    "- Wrote promotion candidates for human or agent review.",
    "- Did not create new memories."
  ].join("\n") + "\n";
}

async function writePromotionCandidates(date: string, now: Date, options: OpenBrainOptions, retentionDays: number) {
  const records = await Promise.all(
    (await markdownFiles(episodesDir(options))).map((filePath) => parseMemoryFile(filePath, retentionDays))
  );
  const candidates = records.filter((record) => record.type === "episode" && record.metadata.promoteAs);
  const target = await uniquePromotionCandidatesPath(date, now, options);
  await writeFile(target, renderPromotionCandidates(candidates), "utf8");
  return target;
}

function renderPromotionCandidates(candidates: MemoryRecord[]) {
  const lines = [
    "# Promotion candidates",
    "",
    "These episodes were marked with `promoteAs`. Review the source text before creating durable memory.",
    ""
  ];

  if (!candidates.length) {
    lines.push("No promotion candidates.");
    return lines.join("\n") + "\n";
  }

  for (const candidate of candidates) {
    const type = candidate.metadata.promoteAs as DurableMemoryType;
    lines.push(`## ${candidate.id}`);
    lines.push("");
    lines.push(`- title: ${candidate.title}`);
    lines.push(`- suggestedType: ${type}`);
    lines.push(`- sourceExcerpt: ${quoteForMarkdown(excerpt(candidate.body, ""))}`);
    lines.push("");
    lines.push("```bash");
    lines.push(`openbrain memory promote ${candidate.id} --type ${type} --text "<final durable memory>"`);
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

function localDateString(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
  source: string;
  scope: string;
  confidence: string;
  expires_at: string | null;
  promoted_from: string | null;
  sensitivity: string;
  promote_as: string | null;
}) {
  return {
    id: row.id,
    type: row.type as StoredMemoryType,
    title: row.title,
    path: row.path,
    createdAt: row.created_at,
    body: row.body,
    metadata: {
      source: row.source,
      scope: row.scope,
      confidence: row.confidence as MemoryRecord["metadata"]["confidence"],
      expiresAt: row.expires_at ?? undefined,
      promotedFrom: row.promoted_from ?? undefined,
      sensitivity: row.sensitivity as MemoryRecord["metadata"]["sensitivity"],
      promoteAs: row.promote_as as MemoryRecord["metadata"]["promoteAs"]
    }
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

function rowMatchesSearchOptions(row: IndexedMemoryRow, options: SearchMemoriesOptions, now: Date) {
  if (!options.includePrivate && row.sensitivity === "private") {
    return false;
  }
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) {
    return false;
  }
  if (options.durableOnly && row.type === "episode") {
    return false;
  }
  if (options.type && row.type !== options.type) {
    return false;
  }
  if (options.scope && row.scope !== options.scope) {
    return false;
  }
  if (options.confidence && row.confidence !== options.confidence) {
    return false;
  }
  return true;
}

function quoteForMarkdown(value: string) {
  return JSON.stringify(value);
}

function episodeTimestamp(filePath: string, fallback: Date) {
  const match = path.basename(filePath).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? new Date(`${match[1]}T00:00:00.000Z`).getTime() : fallback.getTime();
}

function codexBlock() {
  return `${OPENBRAIN_BEGIN}
## OpenBrain Memory

OpenBrain selects the active brain from the current workspace path using
\`~/.openbrain/config.json\`. Use one default brain for the whole machine, or
map filesystem paths to separate memory containers when the user wants
isolation between contexts.

OpenBrain uses the current workspace path only to choose the active brain.
Treat that brain as the memory container. Refer to memory by brain name or
active brain. Refer to paths only when configuring brain routing or discussing
files.

If OpenBrain reports that the current workspace path is not assigned to a brain,
ask the user which brain should own that workspace path, then run:

\`\`\`bash
openbrain brain add-path <brain> "<current workspace path>"
\`\`\`

Before starting a task, run daily maintenance, then search:

\`\`\`bash
openbrain dream maybe --quiet
openbrain memory search "<short description of the user's current task>"
\`\`\`

Use only relevant returned memories.

After a meaningful task, record concise durable memories:

\`\`\`bash
openbrain memory add --type workflow --text "..."
openbrain memory add --type workspace --text "..."
openbrain memory add --type preference --text "..."
openbrain memory add --type decision --text "..."
openbrain memory add --type episode --text "..."
openbrain memory add --type episode --promote-as workflow --text "..."
openbrain memory promote <episode-id> --type workflow --text "..."
\`\`\`

Record durable memories only when the guidance is likely to stay useful across
future tasks. Prefer principles, preferences, repeated workflows, stable
workspace conventions, and durable decisions. Do not store branch names, PR
numbers, commit IDs, stale local state, exact files touched, copied fixture
values, one-off implementation details, or anything likely to drift quickly as
durable memory. If short-lived handoff context is useful, store it as
\`episode\`. Episodes are evidence; durable memories are conclusions.

Use memory types this way:
- \`preference\`: user preferences and standing instructions.
- \`workflow\`: repeated process knowledge, checklists, and classification rules.
- \`workspace\`: stable workspace, toolchain, or recurring task conventions.
- \`decision\`: durable choices and their reason.
- \`episode\`: short-lived session notes, handoff state, or fast-changing facts.

Use metadata only when it materially helps retrieval or review:
- \`--scope <value>\`: narrow retrieval scope.
- \`--confidence low|medium|high\`: confidence in the stored statement.
- \`--sensitivity private\`: local-only memory that requires explicit search opt-in and is never embedded.
- \`--promote-as <durable-type>\`: marks an episode for later review.

Dream writes promotion candidate review files for episodes marked with
\`--promote-as\`. Review source text before running \`openbrain memory promote\`.
Do not promote automatically.

For POC or reference work, classify details before storing them. Keep the
reusable rule, such as how to separate UI, calculation, data contract, fixture,
and product assumption. Avoid storing copied constants or prior implementation
shape unless the user explicitly asks for that context to be remembered.

Never store secrets, credentials, sensitive details, or temporary one-off facts.
${OPENBRAIN_END}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
