import type { SearchResult } from "./types.js";

export const MEMORY_CONTEXT_BYTES = 8192;

export function omittedResultsNotice(omitted: number): string {
  return omitted ? `\n[${omitted} search result(s) omitted by the context budget; narrow the query.]\n` : "";
}

export function packSearchResults(
  candidates: SearchResult[],
  render = (results: SearchResult[], omitted: number) =>
    JSON.stringify(results, null, 2) + omittedResultsNotice(omitted)
) {
  const results: SearchResult[] = [];
  const originals: SearchResult[] = [];
  const fits = (items: SearchResult[], omitted: number) =>
    Buffer.byteLength(render(items, omitted), "utf8") <= MEMORY_CONTEXT_BYTES;

  // Reserve references before bodies so a large first memory cannot hide later matches.
  for (const candidate of candidates) {
    const reference = {
      ...candidate,
      excerpt: `[Incomplete: body omitted; fetch with openbrain memory show ${candidate.id} or memory_show using this id.]`
    };
    const minimum =
      Buffer.byteLength(render([candidate], 0)) < Buffer.byteLength(render([reference], 0))
        ? candidate
        : reference;
    if (fits([...results, minimum], candidates.length - results.length - 1)) {
      results.push(minimum);
      originals.push(candidate);
    }
  }

  const omitted = candidates.length - results.length;
  for (const [index, candidate] of originals.entries()) {
    const previous = results[index]!;
    results[index] = candidate;
    if (!fits(results, omitted)) {
      results[index] = previous;
    }
  }
  return { results, omitted };
}
