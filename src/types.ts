export const DURABLE_MEMORY_TYPES = ["preference", "workflow", "workspace", "decision"] as const;
export const MEMORY_TYPES = [...DURABLE_MEMORY_TYPES, "episode"] as const;
export const STORED_MEMORY_TYPES = [...MEMORY_TYPES, "project"] as const;

export type DurableMemoryType = (typeof DURABLE_MEMORY_TYPES)[number];
export type MemoryType = (typeof MEMORY_TYPES)[number];
export type StoredMemoryType = (typeof STORED_MEMORY_TYPES)[number];
export type MemoryConfidence = "low" | "medium" | "high";
export type MemorySensitivity = "standard" | "private";

export interface MemoryMetadata {
  source: string;
  scope: string;
  confidence: MemoryConfidence;
  expiresAt?: string;
  promotedFrom?: string;
  sensitivity: MemorySensitivity;
  promoteAs?: DurableMemoryType;
  updatedAt?: string;
}

export interface OpenBrainConfig {
  version: 1;
  retentionDays: number;
  brains: {
    default: string;
    unmatched: "default" | "disabled" | "ask";
    pathRules: Array<{
      brain: string;
      paths: string[];
    }>;
  };
  embeddings: {
    enabled: boolean;
    model: string;
    dimensions: number;
    timeoutMs: number;
    loadTimeoutMs: number;
  };
  retrieval: {
    limit: number;
  };
  agents: {
    codex: {
      enabled: boolean;
    };
    claude: {
      enabled: boolean;
    };
  };
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[] | null>;
  // Resolves once the provider can embed without further setup. Model load
  // and download happen here, budgeted separately from embedding itself.
  ready?(): Promise<void>;
  // True for the no-op provider used when embeddings are turned off, so
  // callers can tell "intentionally disabled" apart from "failed".
  disabled?: boolean;
}

// Resolution of the current workspace path to a memory container.
// "active": the brain is usable. "ask": no rule matched and the config says
// to ask which brain owns the path. "disabled": no rule matched and OpenBrain
// is off for unmatched paths.
export interface BrainStatus {
  brain: string;
  state: "active" | "ask" | "disabled";
}

export interface OpenBrainOptions {
  home?: string;
  codexHome?: string;
  claudeHome?: string;
  brain?: string;
  cwd?: string;
  now?: () => Date;
  embedder?: EmbeddingProvider;
}

export interface SetupPathRuleInput {
  brain: string;
  path: string;
}

export interface SetupInput {
  brainScope: "default" | "paths";
  pathRules?: SetupPathRuleInput[];
  // undefined means auto-detect from the agent's config directory.
  syncCodex?: boolean;
  syncClaude?: boolean;
  // Must be explicitly true; OpenBrain never changes Claude's memory setting silently.
  disableClaudeAutoMemory?: boolean;
}

export interface SetupResult {
  brainScope: SetupInput["brainScope"];
  currentBrain: string;
  pathRules: SetupPathRuleInput[];
  codexDetected: boolean;
  claudeDetected: boolean;
  codexAgentFile?: string;
  claudeAgentFile?: string;
  claudeSettingsFile?: string;
}

export interface AddMemoryInput {
  type: MemoryType;
  text: string;
  metadata?: Partial<MemoryMetadata>;
}

export interface MemoryRecord {
  id: string;
  type: StoredMemoryType;
  title: string;
  path: string;
  createdAt: string;
  body: string;
  metadata: MemoryMetadata;
}

// Reported when a new durable memory scores above the duplicate-similarity
// threshold against an existing memory of the same type. The memory is still
// written; the notice tells the caller to consider updating instead.
export interface DuplicateNotice {
  id: string;
  title: string;
  similarity: number;
}

export interface AddMemoryResult extends MemoryRecord {
  duplicateOf?: DuplicateNotice;
}

export interface UpdateMemoryInput {
  id: string;
  text: string;
  metadata?: Partial<MemoryMetadata>;
}

export interface MergeMemoryInput {
  sourceId: string;
  targetId: string;
  text: string;
}

export interface SearchResult {
  id: string;
  type: StoredMemoryType;
  title: string;
  path: string;
  source: string;
  scope: string;
  confidence: MemoryConfidence;
  expiresAt?: string;
  promotedFrom?: string;
  sensitivity: MemorySensitivity;
  promoteAs?: DurableMemoryType;
  score: number;
  excerpt: string;
  match: "fts" | "vector" | "hybrid";
}

export interface SearchMemoriesOptions extends OpenBrainOptions {
  type?: StoredMemoryType;
  scope?: string;
  confidence?: MemoryConfidence;
  durableOnly?: boolean;
  includePrivate?: boolean;
  limit?: number;
}

export interface PromoteMemoryInput {
  episodeId: string;
  type: DurableMemoryType;
  text: string;
}

// A dream-written review file awaiting agent action. Pending means the file
// still sits in the dreams directory; actioned reviews are moved aside by
// "openbrain review done".
export interface PendingReview {
  path: string;
  kind: "promotion-candidates" | "consolidation";
}

export interface DreamRunResult {
  brain: string;
  status: "ran";
  date: string;
  prunedEpisodes: number;
  rebuiltIndex: boolean;
  logPath: string;
  promotionCandidatesPath?: string;
  consolidationReportPath?: string;
}

export interface DreamSkippedResult {
  brain: string;
  status: "skipped";
  date: string;
  reason: "already-dreamed-today" | "dream-already-running";
}

export type DreamResult = DreamRunResult | DreamSkippedResult;

export function isMemoryType(value: string | undefined): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value ?? "");
}

export function isDurableMemoryType(value: string | undefined): value is DurableMemoryType {
  return (DURABLE_MEMORY_TYPES as readonly string[]).includes(value ?? "");
}

export function isStoredMemoryType(value: string | undefined): value is StoredMemoryType {
  return (STORED_MEMORY_TYPES as readonly string[]).includes(value ?? "");
}
