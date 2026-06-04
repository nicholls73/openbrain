import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "./paths.js";
import type { MemoryRecord, OpenBrainOptions } from "./types.js";

export interface IndexedMemoryRow {
  id: string;
  type: string;
  title: string;
  path: string;
  created_at: string;
  body: string;
  embedding: string | null;
}

export async function openDatabase(options: OpenBrainOptions = {}) {
  const file = dbPath(options);
  await mkdir(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      body TEXT NOT NULL,
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
  return db;
}

export function upsertMemory(db: DatabaseSync, record: MemoryRecord, embedding: number[] | null) {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO memories (id, type, title, path, created_at, body, embedding, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      title = excluded.title,
      path = excluded.path,
      created_at = excluded.created_at,
      body = excluded.body,
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
    embedding ? JSON.stringify(embedding) : null,
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

export function clearIndex(db: DatabaseSync) {
  db.exec("DELETE FROM memories; DELETE FROM memories_fts;");
}

export function deleteIndexedMemory(db: DatabaseSync, id: string) {
  deleteFtsRow(db, id);
  db.prepare("DELETE FROM memories WHERE id = ?").run(id);
}

export function getMemoryRow(db: DatabaseSync, id: string) {
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as IndexedMemoryRow | undefined;
}

export function listMemoryRows(db: DatabaseSync) {
  return db
    .prepare("SELECT * FROM memories ORDER BY created_at DESC, id DESC")
    .all() as unknown as IndexedMemoryRow[];
}

export function allRowsWithEmbeddings(db: DatabaseSync) {
  return db
    .prepare("SELECT * FROM memories WHERE embedding IS NOT NULL")
    .all() as unknown as IndexedMemoryRow[];
}

export function ftsSearch(db: DatabaseSync, ftsQuery: string, limit: number) {
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

function deleteFtsRow(db: DatabaseSync, id: string) {
  const rows = db
    .prepare("SELECT rowid FROM memories_fts WHERE id = ?")
    .all(id) as Array<{ rowid: number }>;
  for (const row of rows) {
    db.prepare("DELETE FROM memories_fts WHERE rowid = ?").run(row.rowid);
  }
}
