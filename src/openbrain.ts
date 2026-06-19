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
import { brainHome, codexHome, dreamsDir, episodesDir, memoriesDir, openBrainHome } from "./paths.js";
import { parseMemoryFile, renderMemoryMarkdown, slugify, titleFromText } from "./markdown.js";
import type {
  AddMemoryInput,
  AddMemoryResult,
  DreamResult,
  DreamRunResult,
  EmbeddingProvider,
  MemoryRecord,
  MemoryType,
  OpenBrainOptions,
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
        type: row.type as StoredMemoryType,
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
      // Stored embeddings whose length differs from the current model's output
      // can never match (cosine returns 0). That used to be silent, so swapping
      // the embedding model quietly disabled semantic search for every existing
      // memory. Skip those rows explicitly and tell the user to re-embed.
      let dimensionMismatches = 0;
      const vectorRows = allRowsWithEmbeddings(db)
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
        .slice(0, limit);

      if (dimensionMismatches > 0) {
        console.warn(
          `openbrain: skipped ${dimensionMismatches} memor${dimensionMismatches === 1 ? "y" : "ies"} ` +
            `with embeddings that no longer match the current model (${queryEmbedding.length} dims). ` +
            `Run "openbrain index rebuild" to re-embed them.`
        );
      }

      for (const { row, score } of vectorRows) {
        const existing = merged.get(row.id);
        if (existing) {
          existing.score = Math.max(existing.score, score);
          existing.match = "hybrid";
        } else {
          merged.set(row.id, {
            id: row.id,
            type: row.type as StoredMemoryType,
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
    const record = await parseMemoryFile(filePath);
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
  const pruned = await pruneEpisodes(options);
  await rebuildIndex(options);
  const logPath = await uniqueDreamLogPath(date, now, options);
  const result: DreamRunResult = {
    brain,
    status: "ran",
    date,
    prunedEpisodes: pruned.length,
    rebuiltIndex: true,
    logPath
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

function renderDreamLog(result: DreamRunResult, now: Date) {
  return [
    "# Dream run",
    "",
    `- brain: ${result.brain}`,
    `- date: ${result.date}`,
    `- ranAt: ${now.toISOString()}`,
    `- prunedEpisodes: ${result.prunedEpisodes}`,
    `- rebuiltIndex: ${result.rebuiltIndex}`,
    "",
    "Maintenance performed:",
    "",
    "- Pruned expired episode files.",
    "- Rebuilt the SQLite retrieval index from Markdown.",
    "- Did not create new memories."
  ].join("\n") + "\n";
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
}) {
  return {
    id: row.id,
    type: row.type as StoredMemoryType,
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
\`\`\`

Record durable memories only when the guidance is likely to stay useful across
future tasks. Prefer principles, preferences, repeated workflows, stable
workspace conventions, and durable decisions. Do not store branch names, PR
numbers, commit IDs, stale local state, exact files touched, copied fixture
values, one-off implementation details, or anything likely to drift quickly as
durable memory. If short-lived handoff context is useful, store it as
\`episode\`.

Use memory types this way:
- \`preference\`: user preferences and standing instructions.
- \`workflow\`: repeated process knowledge, checklists, and classification rules.
- \`workspace\`: stable workspace, toolchain, or recurring task conventions.
- \`decision\`: durable choices and their reason.
- \`episode\`: short-lived session notes, handoff state, or fast-changing facts.

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
