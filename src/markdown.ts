import { readFile } from "node:fs/promises";
import path from "node:path";
import type { MemoryRecord, StoredMemoryType } from "./types.js";

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/;

export function titleFromText(text: string) {
  const firstLine = text.trim().split(/\r?\n/)[0] ?? "Memory";
  const boundary = firstLine.search(/[,.!?;:]/);
  const title = (boundary > 0 ? firstLine.slice(0, boundary) : firstLine).trim();
  return title.length > 80 ? title.slice(0, 77).trimEnd() + "..." : title || "Memory";
}

export function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

export function renderMemoryMarkdown(record: MemoryRecord) {
  return [
    "---",
    `id: ${record.id}`,
    `type: ${record.type}`,
    `title: ${record.title}`,
    `createdAt: ${record.createdAt}`,
    "---",
    "",
    record.body.trim(),
    ""
  ].join("\n");
}

export async function parseMemoryFile(filePath: string): Promise<MemoryRecord> {
  const raw = await readFile(filePath, "utf8");
  const match = raw.match(FRONTMATTER);
  if (!match) {
    const title = titleFromText(raw);
    return {
      id: path.basename(filePath, path.extname(filePath)),
      type: "episode",
      title,
      path: filePath,
      createdAt: new Date(0).toISOString(),
      body: raw.trim()
    };
  }

  const meta = parseFrontmatter(match[1] ?? "");
  return {
    id: required(meta, "id", filePath),
    type: required(meta, "type", filePath) as StoredMemoryType,
    title: required(meta, "title", filePath),
    path: filePath,
    createdAt: required(meta, "createdAt", filePath),
    body: (match[2] ?? "").trim()
  };
}

function parseFrontmatter(raw: string) {
  const entries = raw
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => [match[1], match[2]] as const);
  return Object.fromEntries(entries);
}

function required(meta: Record<string, string>, key: string, filePath: string) {
  const value = meta[key];
  if (!value) {
    throw new Error(`Memory file ${filePath} is missing ${key}`);
  }
  return value;
}
