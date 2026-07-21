import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import type { IndexedMemoryRow } from "./db.js";
import {
  allRowsWithEmbeddings,
  clearIndex,
  decodeEmbedding,
  deleteIndexedMemory,
  listMemoryRows,
  openDatabase,
  reencodeEmbedding,
  upsertMemory
} from "./db.js";
import {
  cosine,
  DUPLICATE_SIMILARITY,
  excerpt,
  exists,
  type IndexEntry,
  markdownFiles,
  memoryFiles,
  prepareIndexEntry,
  prepareOpenBrain,
  resolveEmbedder
} from "./internal.js";
import { parseMemoryFile } from "./markdown.js";
import { dreamsDir, episodesDir } from "./paths.js";
import type {
  DreamResult,
  DreamRunResult,
  DurableMemoryType,
  MemoryRecord,
  OpenBrainOptions,
  PendingReview
} from "./types.js";

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

export function findConsolidationGroups(db: Awaited<ReturnType<typeof openDatabase>>, now: Date) {
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

function quoteForMarkdown(value: string) {
  return JSON.stringify(value);
}

function episodeTimestamp(filePath: string, fallback: Date) {
  const match = path.basename(filePath).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? new Date(`${match[1]}T00:00:00.000Z`).getTime() : fallback.getTime();
}
