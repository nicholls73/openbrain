import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IndexedMemoryRow } from "./db.js";
import {
  allRowsWithEmbeddings,
  decodeEmbedding,
  deleteIndexedMemory,
  getMemoryRow,
  listMemoryRows,
  openDatabase,
  upsertMemory
} from "./db.js";
import {
  cosine,
  DUPLICATE_SIMILARITY,
  exists,
  indexMemoryRecord,
  prepareIndexEntry,
  prepareOpenBrain,
  resolveEmbedder
} from "./internal.js";
import { memoryMetadataDefaults, renderMemoryMarkdown, slugify, titleFromText } from "./markdown.js";
import { episodesDir, memoriesDir } from "./paths.js";
import type {
  AddMemoryInput,
  AddMemoryResult,
  DuplicateNotice,
  MemoryRecord,
  MemoryType,
  MergeMemoryInput,
  OpenBrainOptions,
  PromoteMemoryInput,
  StoredMemoryType,
  UpdateMemoryInput
} from "./types.js";

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

export async function listMemories(options: OpenBrainOptions = {}) {
  const { options: scopedOptions } = await prepareOpenBrain(options, { readonly: true });
  const db = await openDatabase(scopedOptions, { readonly: true });
  try {
    return listMemoryRows(db).map(rowToMemoryRecord);
  } finally {
    db.close();
  }
}

export async function showMemory(id: string, options: OpenBrainOptions = {}) {
  const { options: scopedOptions } = await prepareOpenBrain(options, { readonly: true });
  const db = await openDatabase(scopedOptions, { readonly: true });
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
