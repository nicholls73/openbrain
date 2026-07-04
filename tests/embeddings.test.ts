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

  test("gives a slow model load its own budget separate from embedding", async () => {
    const provider: EmbeddingProvider = {
      ready() {
        return new Promise((resolve) => {
          const load = setTimeout(() => resolve(), 50);
          load.unref();
        });
      },
      async embed() {
        return [1, 2, 3];
      }
    };

    // The embed budget alone (10ms) would lose to the 50ms load; the
    // separate load budget lets the cold start finish first.
    expect(await embedWithTimeout(provider, "query", 10, 1000)).toEqual([1, 2, 3]);
  });

  test("returns null when model load exceeds the load budget", async () => {
    const provider: EmbeddingProvider = {
      ready() {
        return new Promise((resolve) => {
          const load = setTimeout(() => resolve(), 100);
          load.unref();
        });
      },
      async embed() {
        return [1, 2, 3];
      }
    };

    expect(await embedWithTimeout(provider, "query", 1000, 5)).toBeNull();
  });
});
