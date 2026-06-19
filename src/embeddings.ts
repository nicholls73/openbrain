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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider.embed(text),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        // Do not let a pending embedding timeout keep the CLI process alive.
        timer.unref();
      })
    ]);
  } catch {
    return null;
  } finally {
    // When embedding wins the race, cancel the still-pending timer so it does
    // not fire (and hold the event loop) for the rest of timeoutMs.
    if (timer) {
      clearTimeout(timer);
    }
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
