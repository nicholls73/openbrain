export type MemoryType = "preference" | "workflow" | "workspace" | "decision" | "episode";
export type StoredMemoryType = MemoryType | "project";
export type DurableMemoryType = Exclude<MemoryType, "episode">;
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
  syncCodex: boolean;
  syncClaude?: boolean;
}

export interface SetupResult {
  brainScope: SetupInput["brainScope"];
  currentBrain: string;
  pathRules: SetupPathRuleInput[];
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
}

export interface PromoteMemoryInput {
  episodeId: string;
  type: DurableMemoryType;
  text: string;
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
  return (
    value === "preference" ||
    value === "workflow" ||
    value === "workspace" ||
    value === "decision" ||
    value === "episode"
  );
}

export function isDurableMemoryType(value: string | undefined): value is DurableMemoryType {
  return value === "preference" || value === "workflow" || value === "workspace" || value === "decision";
}

export function isStoredMemoryType(value: string | undefined): value is StoredMemoryType {
  return isMemoryType(value) || value === "project";
}
