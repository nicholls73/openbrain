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
const GENERATED_LINKS =
  /<!-- BEGIN OPENBRAIN GENERATED LINKS -->[\s\S]*?<!-- END OPENBRAIN GENERATED LINKS -->/g;

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

  if (record.metadata.updatedAt) {
    lines.push(`updatedAt: ${record.metadata.updatedAt}`);
  }
  if (record.metadata.expiresAt) {
    lines.push(`expiresAt: ${record.metadata.expiresAt}`);
  }
  if (record.metadata.relatedTo?.length) {
    lines.push("relatedTo: " + JSON.stringify(record.metadata.relatedTo));
  }
  if (record.metadata.promotedFrom) {
    lines.push(`promotedFrom: ${record.metadata.promotedFrom}`);
  }
  if (record.metadata.promoteAs) {
    lines.push(`promoteAs: ${record.metadata.promoteAs}`);
  }

  return [...lines, "---", "", stripGeneratedLinks(record.body).trim(), ""].join("\n");
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
      body: stripGeneratedLinks(raw).trim(),
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
    body: stripGeneratedLinks(match[2] ?? "").trim(),
    metadata: memoryMetadataDefaults(type, createdAt, retentionDays, {
      source: meta.source,
      scope: meta.scope,
      confidence: parseConfidence(meta.confidence),
      expiresAt: parseExpiresAt(meta.expiresAt, filePath),
      relatedTo: parseRelatedTo(meta.relatedTo),
      promotedFrom: meta.promotedFrom,
      sensitivity: parseSensitivity(meta.sensitivity),
      promoteAs: parseDurableType(meta.promoteAs),
      updatedAt: meta.updatedAt
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

  if (input.promoteAs && !isEpisode) {
    console.warn(`openbrain: ignored promoteAs on non-episode memory type ${type}`);
  }

  const explicitExpiresAt = normalizeExpiresAt(input.expiresAt);
  const expiresAt =
    explicitExpiresAt || (isEpisode ? defaultEpisodeExpiry(createdAt, retentionDays) : undefined);
  if (expiresAt) {
    metadata.expiresAt = expiresAt;
  }
  if (input.promotedFrom?.trim()) {
    metadata.promotedFrom = input.promotedFrom.trim();
  }
  const relatedTo = normalizeRelatedTo(input.relatedTo);
  if (relatedTo.length) {
    metadata.relatedTo = relatedTo;
  }
  if (input.promoteAs && isEpisode) {
    metadata.promoteAs = input.promoteAs;
  }
  if (input.updatedAt?.trim()) {
    metadata.updatedAt = input.updatedAt.trim();
  }

  return metadata;
}

export function parseRelatedTo(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) {
      const relatedTo = normalizeRelatedTo(parsed);
      return relatedTo.length ? relatedTo : undefined;
    }
  } catch {
    // A malformed optional relationship must not make a memory unreadable.
  }
  console.warn("openbrain: ignored invalid relatedTo metadata");
  return undefined;
}

export function replaceGeneratedLinks(
  markdown: string,
  record: MemoryRecord,
  records: MemoryRecord[],
  now: Date
) {
  const block = generatedLinksBlock(record, records, now);
  const matches = markdown.match(GENERATED_LINKS);
  if (matches) {
    let inserted = false;
    return markdown.replace(GENERATED_LINKS, () => {
      if (!inserted && block) {
        inserted = true;
        return block;
      }
      return "";
    });
  }
  if (!block) {
    return markdown;
  }

  const trailingNewlines = markdown.match(/(?:\r?\n)*$/)?.[0] ?? "";
  const content = markdown.slice(0, markdown.length - trailingNewlines.length);
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  return content + (content ? newline + newline : "") + block + (trailingNewlines || newline);
}

function generatedLinksBlock(record: MemoryRecord, records: MemoryRecord[], now: Date) {
  const byId = new Map(records.map((target) => [target.id, target]));
  const ids = normalizeRelatedTo([
    ...(record.metadata.relatedTo ?? []),
    ...(record.metadata.promotedFrom ? [record.metadata.promotedFrom] : [])
  ]).filter((id) => id !== record.id);
  const links: string[] = [];
  for (const id of ids) {
    const target = byId.get(id);
    if (
      !target ||
      target.metadata.sensitivity === "private" ||
      (target.metadata.expiresAt && new Date(target.metadata.expiresAt).getTime() <= now.getTime())
    ) {
      continue;
    }
    const relation = id === record.metadata.promotedFrom ? "Promoted from: " : "Related: ";
    const relativePath = path
      .relative(path.dirname(record.path), target.path)
      .split(path.sep)
      .map((part) =>
        part === ".."
          ? part
          : encodeURIComponent(part).replace(
              /[!'()*]/g,
              (character) => "%" + character.charCodeAt(0).toString(16).toUpperCase()
            )
      )
      .join("/");
    const linkPath = relativePath.startsWith(".") ? relativePath : "./" + relativePath;
    const title = target.title
      .replace(/[\r\n]+/g, " ")
      .replace(/\\/g, "\\\\")
      .replace(/\[/g, "\\[")
      .replace(/\]/g, "\\]");
    links.push("- [" + relation + title + "](" + linkPath + ")");
  }
  if (!links.length) {
    return "";
  }
  return [
    "<!-- BEGIN OPENBRAIN GENERATED LINKS -->",
    "### Related memories",
    "",
    ...links,
    "<!-- END OPENBRAIN GENERATED LINKS -->"
  ].join("\n");
}

function normalizeRelatedTo(values: string[] | undefined) {
  return Array.from(new Set((values ?? []).map((id) => id.trim()).filter(Boolean)));
}

function stripGeneratedLinks(body: string) {
  return body.replace(GENERATED_LINKS, "");
}

function parseFrontmatter(raw: string) {
  const entries: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]?.match(/^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1]!;
    const value = match[2] ?? "";
    if (key === "relatedTo" && !value.trim()) {
      const relatedTo: string[] = [];
      let next = index + 1;
      for (; next < lines.length; next++) {
        const item = lines[next]?.match(/^\s+-\s+(.+?)\s*$/);
        if (!item) {
          break;
        }
        relatedTo.push(parseYamlString(item[1] ?? ""));
      }
      index = next - 1;
      entries[key] = JSON.stringify(relatedTo);
    } else {
      entries[key] = value;
    }
  }
  return entries;
}

function parseYamlString(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === "string") {
        return parsed;
      }
    } catch {
      // Retain an invalid scalar as written so relatedTo validation can omit it.
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function required(meta: Record<string, string>, key: string, filePath: string) {
  const value = meta[key];
  if (!value) {
    throw new Error(`Memory file ${filePath} is missing ${key}`);
  }
  return value;
}

function parseConfidence(value: string | undefined): MemoryConfidence | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  console.warn(`openbrain: ignored invalid confidence metadata: ${value}`);
  return undefined;
}

function parseSensitivity(value: string | undefined): MemorySensitivity | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "standard" || value === "private") {
    return value;
  }
  console.warn(`openbrain: ignored invalid sensitivity metadata: ${value}`);
  return undefined;
}

function parseDurableType(value: string | undefined): DurableMemoryType | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "preference" || value === "workflow" || value === "workspace" || value === "decision") {
    return value;
  }
  console.warn(`openbrain: ignored invalid promoteAs metadata: ${value}`);
  return undefined;
}

function parseExpiresAt(value: string | undefined, filePath: string) {
  return normalizeExpiresAt(value, ` in ${filePath}`);
}

function normalizeExpiresAt(value: string | undefined, context = "") {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!Number.isNaN(new Date(trimmed).getTime())) {
    return trimmed;
  }
  console.warn(`openbrain: ignored invalid expiresAt metadata${context}: ${trimmed}`);
  return undefined;
}

function defaultEpisodeExpiry(createdAt: string, retentionDays: number) {
  const value = new Date(createdAt);
  if (Number.isNaN(value.getTime()) || value.getTime() === 0) {
    return undefined;
  }
  value.setUTCDate(value.getUTCDate() + retentionDays);
  return value.toISOString();
}
