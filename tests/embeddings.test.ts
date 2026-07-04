import { describe, expect, test } from "vitest";
import { embedWithTimeout, serialiseEmbeds } from "../src/embeddings.js";
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

describe("serialiseEmbeds", () => {
  test("keeps at most one embed in flight when callers time out", async () => {
    let started = 0;
    const finishers: Array<() => void> = [];
    const inner: EmbeddingProvider = {
      embed() {
        started += 1;
        return new Promise((resolve) => {
          finishers.push(() => resolve([1]));
        });
      }
    };
    const provider = serialiseEmbeds(inner);

    // Both time out, but only the first ever starts an inference; the second
    // spends its budget queued instead of running alongside a slow embed.
    expect(await embedWithTimeout(provider, "one", 5)).toBeNull();
    expect(await embedWithTimeout(provider, "two", 5)).toBeNull();
    expect(started).toBe(1);

    // Once the slow embed finishes, the queued one starts.
    finishers[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(2);
  });

  test("passes embeds through in order when the provider is fast", async () => {
    const seen: string[] = [];
    const inner: EmbeddingProvider = {
      async embed(text: string) {
        seen.push(text);
        return [seen.length];
      }
    };
    const provider = serialiseEmbeds(inner);

    expect(await provider.embed("first")).toEqual([1]);
    expect(await provider.embed("second")).toEqual([2]);
    expect(seen).toEqual(["first", "second"]);
  });
});
