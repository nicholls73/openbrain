import type { IndexedMemoryRow } from "./db.js";
import { allRowsWithEmbeddings, decodeEmbedding, ftsSearch, openDatabase } from "./db.js";
import { embedWithTimeout } from "./embeddings.js";
import { cosine, excerpt, prepareOpenBrain, resolveEmbedder } from "./internal.js";
import type { SearchMemoriesOptions, SearchResult, StoredMemoryType } from "./types.js";

export async function searchMemories(query: string, options: SearchMemoriesOptions = {}) {
  const { config, options: scopedOptions } = await prepareOpenBrain(options, { readonly: true });
  const db = await openDatabase(scopedOptions, { readonly: true });
  try {
    const limit = options.limit ?? config.retrieval.limit;
    const searchLimit = limit * 20;
    const now = options.now?.() ?? new Date();

    // Reciprocal Rank Fusion combines the FTS and vector result lists by their
    // rank position, not by their raw scores. bm25 ranks and cosine similarity
    // live on different, incomparable scales, so a raw-score merge let whichever
    // scale ran larger dominate regardless of relevance.
    const RRF_K = 60;
    const fused = new Map<string, { row: IndexedMemoryRow; score: number; matches: Set<"fts" | "vector"> }>();

    const fuse = (rows: IndexedMemoryRow[], match: "fts" | "vector") => {
      rows.forEach((row, index) => {
        const contribution = 1 / (RRF_K + index + 1);
        const existing = fused.get(row.id);
        if (existing) {
          existing.score += contribution;
          existing.matches.add(match);
        } else {
          fused.set(row.id, { row, score: contribution, matches: new Set([match]) });
        }
      });
    };

    const filterRows = (rows: IndexedMemoryRow[]) =>
      rows.filter((row) => rowMatchesSearchOptions(row, options, now));

    fuse(filterRows(ftsSearch(db, toFtsQuery(query), searchLimit)).slice(0, limit), "fts");

    const provider = resolveEmbedder(config, options);
    const queryEmbedding = await embedWithTimeout(
      provider,
      query,
      config.embeddings.timeoutMs,
      config.embeddings.loadTimeoutMs
    );
    if (!queryEmbedding && !provider.disabled) {
      // Degrading to FTS-only used to be silent, which made semantic search
      // look enabled while it never actually ran.
      console.warn(
        "openbrain: embedding the query failed or timed out; results are FTS-only. " +
          "A first search may still be downloading the local embedding model."
      );
    }
    if (queryEmbedding) {
      // Stored embeddings whose length differs from the current model's output
      // can never match (cosine returns 0). That used to be silent, so swapping
      // the embedding model quietly disabled semantic search for every existing
      // memory. Skip those rows explicitly and tell the user to re-embed.
      let dimensionMismatches = 0;
      const vectorRows = allRowsWithEmbeddings(db)
        .filter((row) => rowMatchesSearchOptions(row, options, now))
        .map((row) => ({ row, embedding: decodeEmbedding(row.embedding) }))
        .filter((entry): entry is { row: IndexedMemoryRow; embedding: ArrayLike<number> } => {
          if (!entry.embedding) {
            return false;
          }
          if (entry.embedding.length !== queryEmbedding.length) {
            dimensionMismatches += 1;
            return false;
          }
          return true;
        })
        .map(({ row, embedding }) => ({ row, score: cosine(queryEmbedding, embedding) }))
        .filter((result) => result.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map((result) => result.row);

      if (dimensionMismatches > 0) {
        console.warn(
          `openbrain: skipped ${dimensionMismatches} memor${dimensionMismatches === 1 ? "y" : "ies"} ` +
            `with embeddings that no longer match the current model (${queryEmbedding.length} dims). ` +
            `Run "openbrain index rebuild" to re-embed them.`
        );
      }

      fuse(vectorRows, "vector");
    }

    return Array.from(fused.values())
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(
        ({ row, score, matches }): SearchResult => ({
          id: row.id,
          type: row.type as StoredMemoryType,
          title: row.title,
          path: row.path,
          source: row.source,
          scope: row.scope,
          confidence: row.confidence as SearchResult["confidence"],
          expiresAt: row.expires_at ?? undefined,
          promotedFrom: row.promoted_from ?? undefined,
          sensitivity: row.sensitivity as SearchResult["sensitivity"],
          promoteAs: (row.promote_as ?? undefined) as SearchResult["promoteAs"],
          score,
          excerpt: excerpt(row.body, query),
          match: matches.size > 1 ? "hybrid" : ([...matches][0] as "fts" | "vector")
        })
      );
  } finally {
    db.close();
  }
}

function toFtsQuery(query: string) {
  return (
    query
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.map((token) => `${token}*`)
      .join(" OR ") ?? ""
  );
}

function rowMatchesSearchOptions(row: IndexedMemoryRow, options: SearchMemoriesOptions, now: Date) {
  if (!options.includePrivate && row.sensitivity === "private") {
    return false;
  }
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) {
    return false;
  }
  if (options.durableOnly && row.type === "episode") {
    return false;
  }
  if (options.type && row.type !== options.type) {
    return false;
  }
  if (options.scope && row.scope !== options.scope) {
    return false;
  }
  if (options.confidence && row.confidence !== options.confidence) {
    return false;
  }
  return true;
}
