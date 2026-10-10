import { describe, expect, test } from "vitest";
import { omittedResultsNotice, packSearchResults } from "../src/evidence.js";
import type { SearchResult } from "../src/types.js";

function memory(id: string, excerpt: string): SearchResult {
  return {
    id,
    type: "workflow",
    title: id,
    path: `/memories/${id}.md`,
    source: "agent",
    scope: "brain",
    confidence: "high",
    sensitivity: "standard",
    score: 1,
    excerpt,
    match: "hybrid"
  };
}

function delivered(results: SearchResult[]) {
  const packed = packSearchResults(results);
  return { ...packed, text: JSON.stringify(packed.results, null, 2) + omittedResultsNotice(packed.omitted) };
}

describe("memory evidence budget", () => {
  test("keeps complete Unicode memories, including qualifications after character 220", () => {
    const body = "Release checklist. " + "检查 🧠 café\n".repeat(30) + "Only with approval.";
    const result = delivered([memory("release", body)]);
    expect(result.results[0]?.excerpt).toBe(body);
    expect(result.omitted).toBe(0);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8192);
  });

  test("omits an oversized body without hiding a later short memory or cutting Unicode", () => {
    const result = delivered([memory("large", "🧠".repeat(3000)), memory("small", "Keep this condition.")]);
    expect(result.results[0]?.excerpt).toContain("Incomplete");
    expect(result.results[0]?.excerpt).toContain("openbrain memory show large");
    expect(result.results[0]?.excerpt).toContain("memory_show");
    expect(result.results[0]?.excerpt).not.toContain("🧠");
    expect(result.results[1]?.excerpt).toBe("Keep this condition.");
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8192);
  });

  test("shares one budget across memories and counts escaped JSON and all metadata", () => {
    const body = '"\\\n'.repeat(900);
    const result = delivered([memory("first", body), memory("second", body), memory("third", "Still fits.")]);
    expect(result.results[0]?.excerpt).toBe(body);
    expect(result.results[1]?.excerpt).toContain("Incomplete");
    expect(result.results[2]?.excerpt).toBe("Still fits.");
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8192);
  });

  test("reports metadata overflow and still delivers later memories", () => {
    const oversized = { ...memory("metadata", "Small body."), source: "x".repeat(9000) };
    const result = delivered([oversized, memory("next", "Useful context.")]);
    expect(result.results.map(({ id }) => id)).toEqual(["next"]);
    expect(result.omitted).toBe(1);
    expect(omittedResultsNotice(result.omitted)).toMatch(/omitted/i);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(8192);
  });

  test("budgets the caller's full rendered payload including its header", () => {
    const render = (results: SearchResult[], omitted: number) =>
      "Header ".repeat(800) + JSON.stringify(results) + omittedResultsNotice(omitted);
    const packed = packSearchResults(
      [memory("large", "x".repeat(3000)), memory("small", "Complete.")],
      render
    );
    expect(packed.results[0]?.excerpt).toContain("Incomplete");
    expect(packed.results[1]?.excerpt).toBe("Complete.");
    expect(Buffer.byteLength(render(packed.results, packed.omitted))).toBeLessThanOrEqual(8192);
  });

  test("preserves empty results without an omission notice", () => {
    expect(packSearchResults([])).toEqual({ results: [], omitted: 0 });
    expect(omittedResultsNotice(0)).toBe("");
  });
});
