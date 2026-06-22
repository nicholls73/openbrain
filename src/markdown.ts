import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  DurableMemoryType,
  MemoryConfidence,
  MemoryMetadata,
  MemoryRecord,
  MemorySensitivity,
  StoredMemoryType
} from "./types.js";

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
  const lines = [
    "---",
    `id: ${record.id}`,
    `type: ${record.type}`,
    `title: ${record.title}`,
    `createdAt: ${record.createdAt}`,
    `source: ${record.metadata.source}`,
    `scope: ${record.metadata.scope}`,
    `confidence: ${record.metadata.confidence}`,
    `sensitivity: ${record.metadata.sensitivity}`
  ];

  if (record.metadata.expiresAt) {
    lines.push(`expiresAt: ${record.metadata.expiresAt}`);
  }
  if (record.metadata.promotedFrom) {
    lines.push(`promotedFrom: ${record.metadata.promotedFrom}`);
  }
  if (record.metadata.promoteAs) {
    lines.push(`promoteAs: ${record.metadata.promoteAs}`);
  }

  return [
    ...lines,
    "---",
    "",
    record.body.trim(),
    ""
  ].join("\n");
}

export async function parseMemoryFile(filePath: string, retentionDays = 30): Promise<MemoryRecord> {
  const raw = await readFile(filePath, "utf8");
  const match = raw.match(FRONTMATTER);
  if (!match) {
    const title = titleFromText(raw);
    const createdAt = new Date(0).toISOString();
    const type = "episode";
    return {
      id: path.basename(filePath, path.extname(filePath)),
      type,
      title,
      path: filePath,
      createdAt,
      body: raw.trim(),
      metadata: memoryMetadataDefaults(type, createdAt, retentionDays)
    };
  }

  const meta = parseFrontmatter(match[1] ?? "");
  const type = required(meta, "type", filePath) as StoredMemoryType;
  const createdAt = required(meta, "createdAt", filePath);
  return {
    id: required(meta, "id", filePath),
    type,
    title: required(meta, "title", filePath),
    path: filePath,
    createdAt,
    body: (match[2] ?? "").trim(),
    metadata: memoryMetadataDefaults(type, createdAt, retentionDays, {
      source: meta.source,
      scope: meta.scope,
      confidence: parseConfidence(meta.confidence),
      expiresAt: meta.expiresAt,
      promotedFrom: meta.promotedFrom,
      sensitivity: parseSensitivity(meta.sensitivity),
      promoteAs: parseDurableType(meta.promoteAs)
    })
  };
}

export function memoryMetadataDefaults(
  type: StoredMemoryType,
  createdAt: string,
  retentionDays: number,
  input: Partial<MemoryMetadata> = {}
): MemoryMetadata {
  const isEpisode = type === "episode";
  const metadata: MemoryMetadata = {
    source: input.source?.trim() || "agent",
    scope: input.scope?.trim() || (isEpisode ? "session" : "brain"),
    confidence: input.confidence ?? (isEpisode ? "low" : "medium"),
    sensitivity: input.sensitivity ?? "standard"
  };

  const expiresAt = input.expiresAt?.trim() || (isEpisode ? defaultEpisodeExpiry(createdAt, retentionDays) : undefined);
  if (expiresAt) {
    metadata.expiresAt = expiresAt;
  }
  if (input.promotedFrom?.trim()) {
    metadata.promotedFrom = input.promotedFrom.trim();
  }
  if (input.promoteAs && isEpisode) {
    metadata.promoteAs = input.promoteAs;
  }

  return metadata;
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

function parseConfidence(value: string | undefined): MemoryConfidence | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

function parseSensitivity(value: string | undefined): MemorySensitivity | undefined {
  return value === "standard" || value === "private" ? value : undefined;
}

function parseDurableType(value: string | undefined): DurableMemoryType | undefined {
  return value === "preference" || value === "workflow" || value === "workspace" || value === "decision"
    ? value
    : undefined;
}

function defaultEpisodeExpiry(createdAt: string, retentionDays: number) {
  const value = new Date(createdAt);
  if (Number.isNaN(value.getTime())) {
    return undefined;
  }
  value.setUTCDate(value.getUTCDate() + retentionDays);
  return value.toISOString();
}
