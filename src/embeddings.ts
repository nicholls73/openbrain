import { modelCacheDir } from "./paths.js";
import type { EmbeddingProvider, OpenBrainConfig, OpenBrainOptions } from "./types.js";

export function createEmbeddingProvider(
  config: OpenBrainConfig,
  options: OpenBrainOptions = {}
): EmbeddingProvider {
  if (!config.embeddings.enabled || process.env.VITEST) {
    return disabledEmbeddingProvider();
  }

  return options.embedder ?? serialiseEmbeds(new TransformersEmbeddingProvider(config, options));
}

// The local runtime offers no way to abort an inference once started, so a
// timed-out embed keeps computing in the background. Serialising embeds means
// at most one inference is ever in flight: while it runs, queued embeds spend
// their timeout waiting and return null without spawning more work, instead
// of piling up concurrent inferences behind a slow model.
export function serialiseEmbeds(provider: EmbeddingProvider): EmbeddingProvider {
  let inflight: Promise<unknown> = Promise.resolve();
  const serialised: EmbeddingProvider = {
    embed(text: string) {
      const run = inflight.then(() => provider.embed(text));
      inflight = run.catch(() => undefined);
      return run;
    }
  };
  if (provider.ready) {
    serialised.ready = () => provider.ready!();
  }
  if (provider.disabled) {
    serialised.disabled = provider.disabled;
  }
  return serialised;
}

export function disabledEmbeddingProvider(): EmbeddingProvider {
  return {
    disabled: true,
    async embed() {
      return null;
    }
  };
}

const TIMED_OUT = Symbol("timed-out");

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
        // Do not let a pending timeout keep the CLI process alive.
        timer.unref();
      })
    ]);
  } finally {
    // When the work wins the race, cancel the still-pending timer so it does
    // not fire (and hold the event loop) for the rest of the budget.
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function embedWithTimeout(
  provider: EmbeddingProvider,
  text: string,
  timeoutMs: number,
  loadTimeoutMs = timeoutMs
): Promise<number[] | null> {
  try {
    // The first call in a process loads (and on first ever use, downloads)
    // the local model. That gets its own, larger budget: a single budget for
    // load + embed meant every fresh CLI invocation lost most of it to the
    // cold start and silently degraded search to FTS-only.
    if (provider.ready) {
      if ((await withTimeout(provider.ready(), loadTimeoutMs)) === TIMED_OUT) {
        return null;
      }
    }
    const embedding = await withTimeout(provider.embed(text), timeoutMs);
    return embedding === TIMED_OUT ? null : embedding;
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

  async ready() {
    await this.getExtractor();
  }

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
