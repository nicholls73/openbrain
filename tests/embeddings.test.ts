import { describe, expect, test } from "vitest";
import { embedWithTimeout } from "../src/embeddings.js";
import type { EmbeddingProvider } from "../src/types.js";

describe("embedWithTimeout", () => {
  test("returns the embedding when it resolves before the timeout", async () => {
    const provider: EmbeddingProvider = {
      async embed() {
        return [1, 2, 3];
      }
    };

    expect(await embedWithTimeout(provider, "query", 1000)).toEqual([1, 2, 3]);
  });

  test("returns null when the embedding exceeds the timeout", async () => {
    const provider: EmbeddingProvider = {
      embed() {
        return new Promise((resolve) => {
          const slow = setTimeout(() => resolve([1, 2, 3]), 50);
          slow.unref();
        });
      }
    };

    expect(await embedWithTimeout(provider, "query", 5)).toBeNull();
  });

  test("returns null when the embedding throws", async () => {
    const provider: EmbeddingProvider = {
      async embed() {
        throw new Error("embedding unavailable");
      }
    };

    expect(await embedWithTimeout(provider, "query", 1000)).toBeNull();
  });
});
