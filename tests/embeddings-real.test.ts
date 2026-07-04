import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { createEmbeddingProvider, embedWithTimeout } from "../src/embeddings.js";

// Opt-in integration test for the real transformers pipeline: it downloads
// the embedding model on first run, so plain `pnpm test` skips it. Run with:
//   OPENBRAIN_REAL_EMBEDDINGS=1 pnpm vitest run tests/embeddings-real.test.ts
// The model cache lives at a fixed temp path so reruns (and CI caching) reuse
// the downloaded model.
const enabled = process.env.OPENBRAIN_REAL_EMBEDDINGS === "1";
const home = path.join(tmpdir(), "openbrain-real-embeddings");

function cosine(left: number[], right: number[]) {
  let dot = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index]! * right[index]!;
  }
  return dot;
}

describe.runIf(enabled)("real embedding pipeline", () => {
  test("loads the configured model, embeds text, and ranks related text closer", {
    timeout: 300_000
  }, async () => {
    const provider = createEmbeddingProvider(DEFAULT_CONFIG, { home });
    expect(provider.disabled).toBeUndefined();

    const embed = async (text: string) => {
      const embedding = await embedWithTimeout(provider, text, 60_000, 240_000);
      expect(embedding).not.toBeNull();
      expect(embedding).toHaveLength(DEFAULT_CONFIG.embeddings.dimensions);
      return embedding!;
    };

    const deploy = await embed("How do we deploy the payments service to production?");
    const release = await embed("Steps for releasing the payments service to the production environment.");
    const cooking = await embed("My favourite recipe for slow-cooked lamb shoulder.");

    // Mean-pooled, normalised output: unit norm within float tolerance.
    const norm = Math.sqrt(deploy.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 2);

    // Related texts must score meaningfully closer than unrelated ones.
    expect(cosine(deploy, release)).toBeGreaterThan(cosine(deploy, cooking) + 0.2);
  });
});
