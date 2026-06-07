export type MemoryType = "preference" | "workflow" | "project" | "decision" | "episode";

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
  };
  retrieval: {
    limit: number;
  };
  agents: {
    codex: {
      enabled: boolean;
    };
  };
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[] | null>;
}

export interface OpenBrainOptions {
  home?: string;
  codexHome?: string;
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
}

export interface SetupResult {
  brainScope: SetupInput["brainScope"];
  currentBrain: string;
  pathRules: SetupPathRuleInput[];
  codexAgentFile?: string;
}

export interface AddMemoryInput {
  type: MemoryType;
  text: string;
}

export interface MemoryRecord {
  id: string;
  type: MemoryType;
  title: string;
  path: string;
  createdAt: string;
  body: string;
}

export interface AddMemoryResult extends MemoryRecord {}

export interface SearchResult {
  id: string;
  type: MemoryType;
  title: string;
  path: string;
  score: number;
  excerpt: string;
  match: "fts" | "vector" | "hybrid";
}

export interface DreamRunResult {
  brain: string;
  status: "ran";
  date: string;
  prunedEpisodes: number;
  rebuiltIndex: boolean;
  logPath: string;
}

export interface DreamSkippedResult {
  brain: string;
  status: "skipped";
  date: string;
  reason: "already-dreamed-today" | "dream-already-running";
}

export type DreamResult = DreamRunResult | DreamSkippedResult;
