import { modelCacheDir } from "./paths.js";
import type { EmbeddingProvider, OpenBrainConfig, OpenBrainOptions } from "./types.js";

export function createEmbeddingProvider(
  config: OpenBrainConfig,
  options: OpenBrainOptions = {}
): EmbeddingProvider {
  if (!config.embeddings.enabled || process.env.VITEST) {
    return disabledEmbeddingProvider();
  }

  return options.embedder ?? new TransformersEmbeddingProvider(config, options);
}

export function disabledEmbeddingProvider(): EmbeddingProvider {
  return {
    async embed() {
      return null;
    }
  };
}

export async function embedWithTimeout(
  provider: EmbeddingProvider,
  text: string,
  timeoutMs: number
): Promise<number[] | null> {
  try {
    return await Promise.race([
      provider.embed(text),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))
    ]);
  } catch {
    return null;
  }
}

class TransformersEmbeddingProvider implements EmbeddingProvider {
  private extractor: Promise<FeatureExtractor> | undefined;

  constructor(
    private readonly config: OpenBrainConfig,
    private readonly options: OpenBrainOptions
  ) {}

  async embed(text: string) {
    const extractor = await this.getExtractor();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return Array.from(output.data, Number);
  }

  private async getExtractor() {
    this.extractor ??= this.loadExtractor();
    return this.extractor;
  }

  private async loadExtractor() {
    const transformers = await import("@huggingface/transformers");
    transformers.env.cacheDir = modelCacheDir(this.options);
    return (await transformers.pipeline(
      "feature-extraction",
      this.config.embeddings.model
    )) as unknown as FeatureExtractor;
  }
}

type FeatureExtractor = (
  text: string,
  options: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: ArrayLike<number> }>;
