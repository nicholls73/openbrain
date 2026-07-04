import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type Database from "better-sqlite3";
import { dbPath } from "./paths.js";
import type { MemoryRecord, OpenBrainOptions } from "./types.js";

type SqliteDatabase = InstanceType<typeof Database>;
type DatabaseConstructor = typeof Database;

export interface IndexedMemoryRow {
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
  // Float32 blob for rows written by current versions; legacy rows hold JSON
  // text until the next index rebuild rewrites them.
  embedding: Buffer | string | null;
}

// Embeddings are stored as raw little-endian float32 blobs. The previous JSON
// text encoding cost a JSON.parse per row on every vector search and roughly
// 5x the storage.
export function encodeEmbedding(embedding: number[] | null): Buffer | null {
  return embedding ? Buffer.from(new Float32Array(embedding).buffer) : null;
}

export function decodeEmbedding(value: Buffer | string | null): ArrayLike<number> | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "string") {
    // Legacy JSON text row; rewritten as a blob on the next index rebuild.
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as number[]) : null;
    } catch {
      return null;
    }
  }
  if (value.byteLength % 4 !== 0) {
    return null;
  }
  // Copy into a fresh buffer: the Buffer's byteOffset within its pool is not
  // guaranteed to be 4-byte aligned, and Float32Array views require alignment.
  return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

export async function openDatabase(options: OpenBrainOptions = {}) {
  const file = dbPath(options);
  await mkdir(dirname(file), { recursive: true });
  const Database = await loadDatabase();
  const db = openSqliteDatabase(file, Database);
  // OpenBrain is shared by every coding agent on the machine, so multiple
  // processes open this database concurrently. WAL allows a reader and a
  // writer at once, and busy_timeout makes a competing writer wait for the
  // lock instead of failing immediately with SQLITE_BUSY.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      body TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'agent',
      scope TEXT NOT NULL DEFAULT 'brain',
      confidence TEXT NOT NULL DEFAULT 'medium',
      expires_at TEXT,
      promoted_from TEXT,
      sensitivity TEXT NOT NULL DEFAULT 'standard',
      promote_as TEXT,
      embedding TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      id UNINDEXED,
      type,
      title,
      body
    );
  `);
  ensureMemoryColumns(db);
  return db;
}

async function loadDatabase(): Promise<DatabaseConstructor> {
  try {
    return (await import("better-sqlite3")).default;
  } catch (error) {
    if (isSqliteNodeAbiMismatch(error)) {
      throw new Error(sqliteNativeModuleRecoveryMessage(), { cause: error });
    }
    throw error;
  }
}

export function openSqliteDatabase(file: string, Database: DatabaseConstructor) {
  try {
    return new Database(file);
  } catch (error) {
    if (isSqliteNodeAbiMismatch(error)) {
      throw new Error(sqliteNativeModuleRecoveryMessage(), { cause: error });
    }
    throw error;
  }
}

export function sqliteNativeModuleRecoveryMessage() {
  return (
    "OpenBrain SQLite native module was built for another Node.js version.\n\n" +
    "Fix default install:\n  cd ~/.local/share/openbrain/app && pnpm rebuild better-sqlite3\n\n" +
    "If you set OPENBRAIN_INSTALL_DIR, run the rebuild in that custom install directory.\n\n" +
    "Or reinstall OpenBrain:\n  curl -fsSL https://raw.githubusercontent.com/nicholls73/openbrain/main/scripts/install.sh | bash"
  );
}

export function isSqliteNodeAbiMismatch(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("NODE_MODULE_VERSION") && message.includes("better_sqlite3.node");
}

export function upsertMemory(db: SqliteDatabase, record: MemoryRecord, embedding: number[] | null) {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO memories (
      id, type, title, path, created_at, body, source, scope, confidence,
      expires_at, promoted_from, sensitivity, promote_as, embedding, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      title = excluded.title,
      path = excluded.path,
      created_at = excluded.created_at,
      body = excluded.body,
      source = excluded.source,
      scope = excluded.scope,
      confidence = excluded.confidence,
      expires_at = excluded.expires_at,
      promoted_from = excluded.promoted_from,
      sensitivity = excluded.sensitivity,
      promote_as = excluded.promote_as,
      embedding = excluded.embedding,
      updated_at = excluded.updated_at
  `
  ).run(
    record.id,
    record.type,
    record.title,
    record.path,
    record.createdAt,
    record.body,
    record.metadata.source,
    record.metadata.scope,
    record.metadata.confidence,
    record.metadata.expiresAt ?? null,
    record.metadata.promotedFrom ?? null,
    record.metadata.sensitivity,
    record.metadata.promoteAs ?? null,
    encodeEmbedding(embedding),
    now
  );
  deleteFtsRow(db, record.id);
  db.prepare("INSERT INTO memories_fts (id, type, title, body) VALUES (?, ?, ?, ?)").run(
    record.id,
    record.type,
    record.title,
    record.body
  );
}

function ensureMemoryColumns(db: SqliteDatabase) {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((column) => column.name)
  );
  const additions: Array<[string, string]> = [
    ["source", "TEXT NOT NULL DEFAULT 'agent'"],
    ["scope", "TEXT NOT NULL DEFAULT 'brain'"],
    ["confidence", "TEXT NOT NULL DEFAULT 'medium'"],
    ["expires_at", "TEXT"],
    ["promoted_from", "TEXT"],
    ["sensitivity", "TEXT NOT NULL DEFAULT 'standard'"],
    ["promote_as", "TEXT"]
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${definition}`);
    }
  }
}

export function clearIndex(db: SqliteDatabase) {
  db.exec("DELETE FROM memories; DELETE FROM memories_fts;");
}

export function deleteIndexedMemory(db: SqliteDatabase, id: string) {
  deleteFtsRow(db, id);
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

export function getMemoryRow(db: SqliteDatabase, id: string) {
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as IndexedMemoryRow | undefined;
}

export function listMemoryRows(db: SqliteDatabase) {
  return db
    .prepare("SELECT * FROM memories ORDER BY created_at DESC, id DESC")
    .all() as unknown as IndexedMemoryRow[];
}

export function allRowsWithEmbeddings(db: SqliteDatabase) {
  return db
    .prepare("SELECT * FROM memories WHERE embedding IS NOT NULL")
    .all() as unknown as IndexedMemoryRow[];
}

export function ftsSearch(db: SqliteDatabase, ftsQuery: string, limit: number) {
  if (!ftsQuery) {
    return [];
  }

  return db
    .prepare(
      `
      SELECT memories.*, bm25(memories_fts) AS rank
      FROM memories_fts
      JOIN memories ON memories.id = memories_fts.id
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `
    )
    .all(ftsQuery, limit) as unknown as Array<IndexedMemoryRow & { rank: number }>;
}

function deleteFtsRow(db: SqliteDatabase, id: string) {
  const rows = db.prepare("SELECT rowid FROM memories_fts WHERE id = ?").all(id) as Array<{ rowid: number }>;
  for (const row of rows) {
    db.prepare("DELETE FROM memories_fts WHERE rowid = ?").run(row.rowid);
  }
}
