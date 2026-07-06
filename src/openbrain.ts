import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BrainUnavailableError, canonicalPathForRule, resolveBrain } from "./brains.js";
import { loadConfig, updateConfig } from "./config.js";
import type { IndexedMemoryRow } from "./db.js";
import {
  allRowsWithEmbeddings,
  clearIndex,
  decodeEmbedding,
  deleteIndexedMemory,
  ftsSearch,
  getMemoryRow,
  listMemoryRows,
  openDatabase,
  reencodeEmbedding,
  upsertMemory
} from "./db.js";
import { createEmbeddingProvider, embedWithTimeout } from "./embeddings.js";
import {
  memoryMetadataDefaults,
  parseMemoryFile,
  renderMemoryMarkdown,
  slugify,
  titleFromText
} from "./markdown.js";
import {
  brainHome,
  claudeHome,
  claudeSettingsPath,
  codexHome,
  dreamsDir,
  episodesDir,
  memoriesDir,
  openBrainHome
} from "./paths.js";
import type {
  AddMemoryInput,
  AddMemoryResult,
  BrainStatus,
  DreamResult,
  DreamRunResult,
  DuplicateNotice,
  DurableMemoryType,
  EmbeddingProvider,
  MemoryRecord,
  MemoryType,
  MergeMemoryInput,
  OpenBrainConfig,
  OpenBrainOptions,
  PendingReview,
  PromoteMemoryInput,
  SearchMemoriesOptions,
  SearchResult,
  SetupInput,
  SetupResult,
  StoredMemoryType,
  UpdateMemoryInput
} from "./types.js";

export const OPENBRAIN_BEGIN = "<!-- BEGIN OPENBRAIN -->";
const OPENBRAIN_END = "<!-- END OPENBRAIN -->";

// Stable marker for the Claude Code SessionStart hook command. The adapter keys
// idempotent settings.json merges off this substring, so it must not change.
export const CLAUDE_HOOK_COMMAND = "openbrain hook session-start";

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

// Detection is deliberately just "does the agent's config directory exist".
// Both CLIs create their directory on first run, and it is the same location
// the adapters write to, so it never force-creates config for an absent agent.
export async function detectCodexAgent(options: OpenBrainOptions = {}) {
  return directoryExists(codexHome(options));
}

export async function detectClaudeAgent(options: OpenBrainOptions = {}) {
  return directoryExists(claudeHome(options));
}

async function directoryExists(dir: string) {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
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

// New durable memories at or above this cosine similarity to an existing
// memory of the same type are flagged as likely duplicates. The memory is
// still written; the notice nudges the caller towards memory update instead.
const DUPLICATE_SIMILARITY = 0.9;

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

  const provider = resolveEmbedder(config, scopedOptions);
  const entry = await prepareIndexEntry(record, config, provider);
  const db = await openDatabase(scopedOptions);
  let duplicateOf: DuplicateNotice | undefined;
  try {
    // The embedding is already computed for indexing, so the duplicate check
    // costs one scan. Episodes are exempt: they are expected to repeat.
    if (record.type !== "episode" && entry.embedding && !Buffer.isBuffer(entry.embedding)) {
      duplicateOf = findNearDuplicate(db, record, entry.embedding, now);
    }
    await writeFile(record.path, renderMemoryMarkdown(record), "utf8");
    upsertMemory(db, entry.record, entry.embedding);
  } finally {
    db.close();
  }
  return duplicateOf ? { ...entry.record, duplicateOf } : entry.record;
}

function findNearDuplicate(
  db: Awaited<ReturnType<typeof openDatabase>>,
  record: MemoryRecord,
  embedding: ArrayLike<number>,
  now: Date
): DuplicateNotice | undefined {
  let best: DuplicateNotice | undefined;
  for (const row of allRowsWithEmbeddings(db)) {
    if (row.id === record.id || row.type !== record.type || row.sensitivity === "private") {
      continue;
    }
    if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) {
      continue;
    }
    const stored = decodeEmbedding(row.embedding);
    if (!stored || stored.length !== embedding.length) {
      continue;
    }
    const similarity = cosine(embedding, stored);
    if (similarity >= DUPLICATE_SIMILARITY && (!best || similarity > best.similarity)) {
      best = { id: row.id, title: row.title, similarity };
    }
  }
  return best;
}

export async function updateMemory(
  input: UpdateMemoryInput,
  options: OpenBrainOptions = {}
): Promise<MemoryRecord> {
  const { config, options: scopedOptions } = await prepareOpenBrain(options);
  const db = await openDatabase(scopedOptions);
  let row: IndexedMemoryRow;
  try {
    const existing = getMemoryRow(db, input.id);
    if (!existing) {
      throw new Error(`Memory not found: ${input.id}`);
    }
    row = existing;
  } finally {
    db.close();
  }

  const now = options.now?.() ?? new Date();
  const record: MemoryRecord = {
    id: row.id,
    type: row.type as StoredMemoryType,
    title: titleFromText(input.text),
    path: row.path,
    createdAt: row.created_at,
    body: input.text.trim(),
    metadata: memoryMetadataDefaults(row.type as StoredMemoryType, row.created_at, config.retentionDays, {
      source: input.metadata?.source ?? row.source,
      scope: input.metadata?.scope ?? row.scope,
      confidence: input.metadata?.confidence ?? (row.confidence as MemoryRecord["metadata"]["confidence"]),
      expiresAt: input.metadata?.expiresAt ?? row.expires_at ?? undefined,
      promotedFrom: row.promoted_from ?? undefined,
      sensitivity:
        input.metadata?.sensitivity ?? (row.sensitivity as MemoryRecord["metadata"]["sensitivity"]),
      promoteAs: (row.promote_as ?? undefined) as MemoryRecord["metadata"]["promoteAs"],
      updatedAt: now.toISOString()
    })
  };

  await writeFile(record.path, renderMemoryMarkdown(record), "utf8");
  await indexMemoryRecord(record, scopedOptions);
  return record;
}

// Fold one durable memory into another: the target gets the merged text, the
// source is deleted. Meant for acting on the dream consolidation report.
export async function mergeMemory(input: MergeMemoryInput, options: OpenBrainOptions = {}) {
  if (input.sourceId === input.targetId) {
    throw new Error("memory merge requires two different memory ids");
  }
  const { options: scopedOptions } = await prepareOpenBrain(options);
  const db = await openDatabase(scopedOptions);
  try {
    for (const id of [input.sourceId, input.targetId]) {
      if (!getMemoryRow(db, id)) {
        throw new Error(`Memory not found: ${id}`);
      }
    }
  } finally {
    db.close();
  }

  const updated = await updateMemory({ id: input.targetId, text: input.text }, scopedOptions);
  await deleteMemory(input.sourceId, scopedOptions);
  return updated;
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
    const fused = new Map<string, { row: IndexedMemoryRow; score: number; matches: Set<"fts" | "vector"> }>();

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
    const queryEmbedding = await embedWithTimeout(
      provider,
      query,
      config.embeddings.timeoutMs,
      config.embeddings.loadTimeoutMs
    );
    if (!queryEmbedding && !provider.disabled) {
      // Degrading to FTS-only used to be silent, which made semantic search
      // look enabled while it never actually ran.
      console.warn(
        "openbrain: embedding the query failed or timed out; results are FTS-only. " +
          "A first search may still be downloading the local embedding model."
      );
    }
    if (queryEmbedding) {
      // Stored embeddings whose length differs from the current model's output
      // can never match (cosine returns 0). That used to be silent, so swapping
      // the embedding model quietly disabled semantic search for every existing
      // memory. Skip those rows explicitly and tell the user to re-embed.
      let dimensionMismatches = 0;
      const vectorRows = allRowsWithEmbeddings(db)
        .filter((row) => rowMatchesSearchOptions(row, options, now))
        .map((row) => ({ row, embedding: decodeEmbedding(row.embedding) }))
        .filter((entry): entry is { row: IndexedMemoryRow; embedding: ArrayLike<number> } => {
          if (!entry.embedding) {
            return false;
          }
          if (entry.embedding.length !== queryEmbedding.length) {
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
      .map(
        ({ row, score, matches }): SearchResult => ({
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
        })
      );
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

  // Reuse stored embeddings for memories whose title and body are unchanged,
  // so routine rebuilds (the daily dream fired from session-start hooks) do
  // not re-embed the whole brain. Only new or edited files, and files whose
  // previous embedding failed, pay the embedding cost.
  const stored = new Map<string, IndexedMemoryRow>();
  {
    const db = await openDatabase(scopedOptions);
    try {
      for (const row of allRowsWithEmbeddings(db)) {
        stored.set(row.id, row);
      }
    } finally {
      db.close();
    }
  }

  // Parse and embed everything before touching the database. Embedding is the
  // slow part; doing it up front keeps the write transaction below brief. The
  // provider is built once and reused so the local embedding model is not
  // reloaded per file.
  const provider = resolveEmbedder(config, scopedOptions);
  const entries: IndexEntry[] = [];
  let embedFailures = 0;
  for (const filePath of await memoryFiles(scopedOptions)) {
    const record = await parseMemoryFile(filePath, config.retentionDays);
    const prior = stored.get(record.id);
    if (
      record.metadata.sensitivity !== "private" &&
      prior &&
      prior.title === record.title &&
      prior.body === record.body
    ) {
      const reused = reencodeEmbedding(prior.embedding);
      if (reused) {
        entries.push({ record, embedding: reused });
        continue;
      }
    }
    const entry = await prepareIndexEntry(record, config, provider);
    if (!entry.embedding && !provider.disabled && entry.record.metadata.sensitivity !== "private") {
      embedFailures += 1;
    }
    entries.push(entry);
  }
  if (embedFailures > 0) {
    console.warn(
      `openbrain: ${embedFailures} memor${embedFailures === 1 ? "y was" : "ies were"} indexed without ` +
        `embeddings (embedding failed or timed out). Semantic search will not match them; run ` +
        `"openbrain index rebuild" once the model is available.`
    );
  }

  // Clear + reinsert in one transaction on one connection. Other agents'
  // searches see the old index until commit, never an empty or partial one,
  // and a parse failure above aborts before anything is deleted.
  const db = await openDatabase(scopedOptions);
  try {
    db.transaction(() => {
      clearIndex(db);
      for (const entry of entries) {
        upsertMemory(db, entry.record, entry.embedding);
      }
    })();
  } finally {
    db.close();
  }
}

export async function pruneEpisodes(options: OpenBrainOptions = {}) {
  const { config, options: scopedOptions } = await prepareOpenBrain(options);
  const now = options.now?.() ?? new Date();
  const pruned: string[] = [];
  const db = await openDatabase(scopedOptions);
  try {
    const rowsByPath = new Map(listMemoryRows(db).map((row) => [row.path, row]));
    for (const filePath of await markdownFiles(episodesDir(scopedOptions))) {
      if (!(await episodeExpired(filePath, config.retentionDays, now))) {
        continue;
      }
      const row = rowsByPath.get(filePath);
      await rm(filePath, { force: true });
      if (row) {
        deleteIndexedMemory(db, row.id);
      }
      pruned.push(filePath);
    }
  } finally {
    db.close();
  }
  return pruned;
}

// An episode is pruned once its effective expiry passes: the explicit or
// defaulted expiresAt from its metadata, which is the same value search uses
// to hide it, so prune and search agree on episode lifetime. Files without a
// usable expiry (no frontmatter, or frontmatter that fails to parse) keep the
// filename-date/mtime retention cutoff.
async function episodeExpired(filePath: string, retentionDays: number, now: Date) {
  try {
    const record = await parseMemoryFile(filePath, retentionDays);
    if (record.metadata.expiresAt) {
      return new Date(record.metadata.expiresAt).getTime() <= now.getTime();
    }
  } catch {
    // Unparseable episodes fall through to filename/mtime-based retention.
  }
  const stats = await stat(filePath);
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  return episodeTimestamp(filePath, stats.mtime) + retentionMs < now.getTime();
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
  return runDreamWithLock(scopedOptions, resolution.brain, now, () =>
    performDream(scopedOptions, resolution.brain, now)
  );
}

const REVIEW_FILE_PATTERN = /-(promotion-candidates|consolidation)(-\d+)?\.md$/;
// Dreams before v0.5 wrote review files even when there was nothing to
// action; these markers identify them so they never show up as pending.
const LEGACY_EMPTY_MARKERS = ["No promotion candidates.", "No likely duplicates."];

// Reviews are pending while their file sits in the dreams directory;
// "openbrain review done" moves them into dreams/actioned. Presence is the
// only state, so the queue survives crashes and stays inspectable as files.
export async function listPendingReviews(options: OpenBrainOptions = {}): Promise<PendingReview[]> {
  const { options: scopedOptions } = await prepareOpenBrain(options);
  const dir = dreamsDir(scopedOptions);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const pending: PendingReview[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const kind = entry.name.match(REVIEW_FILE_PATTERN)?.[1] as PendingReview["kind"] | undefined;
    if (!entry.isFile() || !kind) {
      continue;
    }
    const filePath = path.join(dir, entry.name);
    const content = await readFile(filePath, "utf8");
    if (LEGACY_EMPTY_MARKERS.some((marker) => content.includes(marker))) {
      continue;
    }
    pending.push({ path: filePath, kind });
  }
  return pending;
}

export async function markReviewDone(file: string, options: OpenBrainOptions = {}) {
  const { options: scopedOptions } = await prepareOpenBrain(options);
  const base = path.basename(file);
  if (!REVIEW_FILE_PATTERN.test(base)) {
    throw new Error(`Not a review file: ${file}`);
  }
  const dir = dreamsDir(scopedOptions);
  const source = path.join(dir, base);
  if (!(await exists(source))) {
    throw new Error(`Review file not found: ${source}`);
  }
  const actionedDir = path.join(dir, "actioned");
  await mkdir(actionedDir, { recursive: true });
  const target = path.join(actionedDir, base);
  await rename(source, target);
  return target;
}

export async function syncCodexAgent(options: OpenBrainOptions = {}) {
  return syncInstructionFile(codexHome(options), "AGENTS.md", options);
}

export async function syncClaudeAgent(options: OpenBrainOptions = {}) {
  const file = await syncInstructionFile(claudeHome(options), "CLAUDE.md", options);
  // The CLAUDE.md block is advisory only. Install a SessionStart hook so Claude
  // Code actually runs daily dreaming and is reminded to search memory on every
  // session, without relying on the agent to follow the instructions.
  await syncClaudeSettings(options);
  return file;
}

// Merge the OpenBrain SessionStart hook into the user's Claude Code
// settings.json, preserving any existing settings and hooks. Idempotent: a
// re-sync replaces our prior entry rather than appending a duplicate.
export async function syncClaudeSettings(options: OpenBrainOptions = {}) {
  const file = claudeSettingsPath(options);
  await mkdir(path.dirname(file), { recursive: true });

  let settings: Record<string, unknown> = {};
  try {
    const raw = await readFile(file, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];

  // Drop any prior OpenBrain command entries, then any group left empty, so
  // repeated syncs never accumulate duplicate hooks.
  const cleaned = sessionStart
    .map((group) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        return group;
      }
      const remaining = group.hooks.filter(
        (entry) =>
          !(
            isRecord(entry) &&
            typeof entry.command === "string" &&
            entry.command.includes(CLAUDE_HOOK_COMMAND)
          )
      );
      return { ...group, hooks: remaining };
    })
    .filter((group) => !(isRecord(group) && Array.isArray(group.hooks) && group.hooks.length === 0));

  cleaned.push({
    hooks: [{ type: "command", command: CLAUDE_HOOK_COMMAND }]
  });

  hooks.SessionStart = cleaned;
  settings.hooks = hooks;

  await writeFile(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return file;
}

// Body of the `openbrain hook session-start` command. Claude Code runs this at
// session start and injects stdout as context. Never throws: a failing
// SessionStart hook must not block the session. The guidance it returns depends
// on whether a brain is actually available for the current workspace path, so
// it never tells the agent memory is active when it is not.
export async function runSessionStartHook(options: OpenBrainOptions = {}): Promise<string> {
  const cwd = options.cwd ?? process.cwd();

  let status: BrainStatus;
  try {
    status = await getBrainStatus(options);
  } catch {
    // Resolution itself failed; give safe guidance without claiming memory works.
    return [
      "OpenBrain could not resolve a brain for this workspace path.",
      `If this is unexpected, check ~/.openbrain/config.json. Do not assume memory is available for ${cwd}.`
    ].join("\n");
  }

  if (status.state === "ask") {
    return [
      "OpenBrain has no brain assigned to this workspace path.",
      `Ask the user which brain should own this path, then run: openbrain brain add-path <brain> "${cwd}"`,
      "Do not search or record memory until a brain is assigned."
    ].join("\n");
  }
  if (status.state === "disabled") {
    return [
      "OpenBrain is disabled for this workspace path.",
      "Skip memory search and recording for this session."
    ].join("\n");
  }

  // Brain is available: run daily maintenance (best-effort) and give the agent
  // the search/record reminder.
  try {
    await dreamMaybe(options);
  } catch {
    // Dreaming is best-effort. Swallow so the session always starts.
  }
  const lines = [
    `OpenBrain memory is active (brain: ${status.brain}).`,
    `Before starting a task, run: openbrain memory search "<short description of the task>" and use only relevant results.`,
    `After meaningful work, record durable memories with: openbrain memory add --type <preference|workflow|workspace|decision|episode> --text "...".`,
    `Daily dreaming has already been handled for this session.`
  ];

  // Dream proposes; agents dispose. Without this nudge the review files have
  // no consumer and pile up unread, so surfacing them here closes the loop.
  const pending = await listPendingReviews(options).catch(() => [] as PendingReview[]);
  if (pending.length > 0) {
    lines.push(
      `Pending memory reviews (${pending.length}):`,
      ...pending.map((review) => `- ${review.path}`),
      `Read each review file and action its suggestions with openbrain memory promote/update/merge/delete, asking the user only where a judgement call is needed. Never merge or promote without reading the memories first.`,
      `After actioning a review, mark it handled: openbrain review done <file>.`
    );
  }
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function syncInstructionFile(dir: string, fileName: string, options: OpenBrainOptions = {}) {
  const config = await loadConfig(options);
  await initOpenBrain({ ...options, brain: config.brains.default });
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, fileName);
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

interface IndexEntry {
  record: MemoryRecord;
  embedding: number[] | Buffer | null;
}

async function prepareIndexEntry(
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

async function indexMemoryRecord(
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
    await writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ createdAt: now.toISOString() }, null, 2)}\n`,
      "utf8"
    );
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
  const consolidationReportPath = await writeConsolidationReport(date, now, options);
  const logPath = await uniqueDreamFilePath("dream", date, now, options);
  const result: DreamRunResult = {
    brain,
    status: "ran",
    date,
    prunedEpisodes: pruned.length,
    rebuiltIndex: true,
    logPath,
    promotionCandidatesPath,
    consolidationReportPath
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

async function uniqueDreamFilePath(kind: string, date: string, now: Date, options: OpenBrainOptions) {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  const base = path.join(dreamsDir(options), `${date}-${timestamp}-${kind}`);
  let candidate = `${base}.md`;
  let suffix = 2;
  while (await exists(candidate)) {
    candidate = `${base}-${suffix++}.md`;
  }
  return candidate;
}

function renderDreamLog(result: DreamRunResult, now: Date) {
  return (
    [
      "# Dream run",
      "",
      `- brain: ${result.brain}`,
      `- date: ${result.date}`,
      `- ranAt: ${now.toISOString()}`,
      `- prunedEpisodes: ${result.prunedEpisodes}`,
      `- rebuiltIndex: ${result.rebuiltIndex}`,
      `- promotionCandidates: ${result.promotionCandidatesPath ?? "none"}`,
      `- consolidationReport: ${result.consolidationReportPath ?? "none"}`,
      "",
      "Maintenance performed:",
      "",
      "- Pruned expired episode files.",
      "- Rebuilt the SQLite retrieval index from Markdown.",
      "- Wrote promotion candidates for human or agent review.",
      "- Wrote a consolidation review of likely duplicate durable memories.",
      "- Did not create, merge, or delete memories."
    ].join("\n") + "\n"
  );
}

async function writePromotionCandidates(
  date: string,
  now: Date,
  options: OpenBrainOptions,
  retentionDays: number
) {
  const records = await Promise.all(
    (await markdownFiles(episodesDir(options))).map((filePath) => parseMemoryFile(filePath, retentionDays))
  );
  const candidates = records.filter((record) => record.type === "episode" && record.metadata.promoteAs);
  // Review files exist to be actioned by agents; a file with nothing to do
  // would just be noise in the pending-review queue.
  if (!candidates.length) {
    return undefined;
  }
  const target = await uniqueDreamFilePath("promotion-candidates", date, now, options);
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

interface ConsolidationGroup {
  similarity: number;
  rows: IndexedMemoryRow[];
}

// Dream proposes, the agent or human disposes: the report lists likely
// duplicate durable memories with ready-to-run commands, and dream itself
// never merges or deletes anything.
async function writeConsolidationReport(date: string, now: Date, options: OpenBrainOptions) {
  const db = await openDatabase(options);
  let groups: ConsolidationGroup[];
  try {
    groups = findConsolidationGroups(db, now);
  } finally {
    db.close();
  }
  if (!groups.length) {
    return undefined;
  }
  const target = await uniqueDreamFilePath("consolidation", date, now, options);
  await writeFile(target, renderConsolidationReport(groups), "utf8");
  return target;
}

function findConsolidationGroups(db: Awaited<ReturnType<typeof openDatabase>>, now: Date) {
  const rows = allRowsWithEmbeddings(db).filter(
    (row) =>
      row.type !== "episode" &&
      row.sensitivity !== "private" &&
      !(row.expires_at && new Date(row.expires_at).getTime() <= now.getTime())
  );
  const embeddings = rows.map((row) => decodeEmbedding(row.embedding));

  // Greedy clustering over pairwise cosine similarity. Durable memory counts
  // are small (hundreds), so the O(n^2) scan is fine and keeps this free of
  // extra dependencies.
  const groupOf = new Map<number, number>();
  const groups: ConsolidationGroup[] = [];
  for (let left = 0; left < rows.length; left++) {
    const leftEmbedding = embeddings[left];
    if (!leftEmbedding) {
      continue;
    }
    for (let right = left + 1; right < rows.length; right++) {
      const rightEmbedding = embeddings[right];
      if (!rightEmbedding || rows[left]!.type !== rows[right]!.type) {
        continue;
      }
      if (leftEmbedding.length !== rightEmbedding.length) {
        continue;
      }
      const similarity = cosine(leftEmbedding, rightEmbedding);
      if (similarity < DUPLICATE_SIMILARITY) {
        continue;
      }
      const existing = groupOf.get(left);
      if (existing === undefined) {
        groupOf.set(left, groups.length);
        groupOf.set(right, groups.length);
        groups.push({ similarity, rows: [rows[left]!, rows[right]!] });
      } else if (!groupOf.has(right)) {
        groupOf.set(right, existing);
        const group = groups[existing]!;
        group.rows.push(rows[right]!);
        group.similarity = Math.max(group.similarity, similarity);
      }
    }
  }
  return groups;
}

function renderConsolidationReport(groups: ConsolidationGroup[]) {
  const lines = [
    "# Consolidation review",
    "",
    "Durable memories of the same type whose embeddings are highly similar.",
    "Review each group: they may be duplicates to merge, or contradictions to",
    "resolve with an update. Dream never merges or deletes memories itself.",
    ""
  ];

  groups.forEach((group, index) => {
    const keep = group.rows[0]!;
    const others = group.rows.slice(1);
    lines.push(`## Group ${index + 1} (similarity ${group.similarity.toFixed(2)})`);
    lines.push("");
    for (const row of group.rows) {
      lines.push(`- [${row.id}] ${row.title}`);
    }
    lines.push("");
    lines.push("```bash");
    for (const row of group.rows) {
      lines.push(`openbrain memory show ${row.id}`);
    }
    for (const other of others) {
      lines.push(`openbrain memory merge ${other.id} --into ${keep.id} --text "<merged durable memory>"`);
    }
    lines.push("```");
    lines.push("");
  });

  return `${lines.join("\n")}\n`;
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

async function uniqueMemoryId(type: MemoryType, title: string, now: Date, options: OpenBrainOptions) {
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

export async function memoryFiles(options: OpenBrainOptions) {
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
  return (
    query
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.map((token) => `${token}*`)
      .join(" OR ") ?? ""
  );
}

function excerpt(body: string, query: string) {
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

function cosine(left: ArrayLike<number>, right: ArrayLike<number>) {
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
files. Git worktrees automatically use the brain of their source repository,
so a worktree created from a mapped path needs no extra configuration.

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

When an existing memory is outdated or a search result already covers the same
fact, revise it instead of adding a near-duplicate:

\`\`\`bash
openbrain memory update <id> --text "..."
openbrain memory merge <source-id> --into <target-id> --text "..."
\`\`\`

If \`memory add\` reports a possible duplicate, follow its suggestion: fold the
fact into the existing memory with \`memory update\` and delete the new copy.

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

Dream also writes a consolidation review of likely duplicate durable memories
with ready-to-run merge commands. Review the memories before merging; never
merge automatically.

Dream proposes; you dispose. Check for unactioned review files with:

\`\`\`bash
openbrain review list
\`\`\`

Read each pending file and action its suggestions with \`memory promote\`,
\`update\`, \`merge\`, or \`delete\`, asking the user only where a judgement call
is needed. Then mark it handled:

\`\`\`bash
openbrain review done <file>
\`\`\`

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
