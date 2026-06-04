export type MemoryType = "preference" | "workflow" | "project" | "decision" | "episode";

export interface OpenBrainConfig {
  version: 1;
  retentionDays: number;
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
  now?: () => Date;
  embedder?: EmbeddingProvider;
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
