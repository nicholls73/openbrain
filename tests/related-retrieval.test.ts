import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { addMemory, runUserPromptSubmitHook, searchMemories, updateMemory } from "../src/openbrain.js";
import type { EmbeddingProvider, OpenBrainOptions } from "../src/types.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function tempHome() {
  const home = await mkdtemp(path.join(tmpdir(), "openbrain-related-retrieval-"));
  homes.push(home);
  return home;
}

function options(home: string, embedder: EmbeddingProvider, brain = "main"): OpenBrainOptions {
  return { home, brain, now: () => new Date("2026-06-04T09:30:00.000Z"), embedder };
}

describe("one-step related memory retrieval", () => {
  test("adds independently relevant links after direct matches, deduplicated and within the result limit", async () => {
    const home = await tempHome();
    const embedder: EmbeddingProvider = {
      async embed(text) {
        return /relationneedle|linked evidence|direct decoy/i.test(text) ? [1, 0] : [0, 1];
      }
    };
    const config = options(home, embedder);
    const sourceA = await addMemory({ type: "decision", text: "relationneedle direct source A." }, config);
    const sourceB = await addMemory({ type: "workflow", text: "relationneedle direct source B." }, config);
    for (const text of ["A direct decoy one.", "A direct decoy two.", "A direct decoy three."]) {
      await addMemory({ type: "preference", text }, config);
    }
    const target = await addMemory(
      {
        type: "workspace",
        text: "Linked evidence: verify deployment health before release.",
        metadata: { relatedTo: [sourceA.id] }
      },
      config
    );
    const transitive = await addMemory(
      {
        type: "workspace",
        text: "Linked evidence: secondary deployment verification details.",
        metadata: { relatedTo: [target.id] }
      },
      config
    );
    await updateMemory(
      { id: target.id, text: target.body, metadata: { relatedTo: [sourceA.id, transitive.id] } },
      config
    );
    await updateMemory(
      {
        id: sourceA.id,
        text: sourceA.body,
        metadata: { relatedTo: ["missing-memory-id", target.id, target.id] }
      },
      config
    );
    await updateMemory({ id: sourceB.id, text: sourceB.body, metadata: { relatedTo: [target.id] } }, config);

    const results = await searchMemories("relationneedle", { ...config, limit: 4 });
    const linked = results.filter((result) => result.id === target.id);

    expect(results).toHaveLength(4);
    expect(results[0]?.id).toBe(sourceA.id);
    expect(linked).toHaveLength(1);
    expect(linked[0]?.match).toBe("vector");
    expect([sourceA.id, sourceB.id]).toContain(linked[0]?.relatedFrom);
    expect(results.filter((result) => result.id === sourceA.id)).toHaveLength(1);
    expect(results.some((result) => result.id === transitive.id)).toBe(false);
    expect(results.slice(0, -1).every((result) => !result.relatedFrom)).toBe(true);
    expect(results.at(-1)?.id).toBe(target.id);
  });

  test("does not treat a link as query relevance or change results when there are no links", async () => {
    const home = await tempHome();
    const embedder: EmbeddingProvider = {
      async embed(text) {
        return text.includes("irrelevantneedle") ? [1, 0] : [0, 1];
      }
    };
    const config = options(home, embedder);
    const source = await addMemory({ type: "decision", text: "irrelevantneedle direct result." }, config);
    const target = await addMemory({ type: "workflow", text: "A gardening note about tomatoes." }, config);
    await updateMemory(
      { id: source.id, text: source.body, metadata: { relatedTo: ["missing-id", target.id] } },
      config
    );

    const linkedSearch = await searchMemories("irrelevantneedle", { ...config, limit: 3 });
    expect(linkedSearch.map((result) => result.id)).toEqual([source.id]);

    const noLinkEmbedder: EmbeddingProvider = {
      disabled: true,
      async embed() {
        return null;
      }
    };
    const noLinkConfig = options(home, noLinkEmbedder);
    for (const text of [
      "unlinkedneedle direct note one.",
      "unlinkedneedle direct note two.",
      "unlinkedneedle direct note three."
    ]) {
      await addMemory({ type: "preference", text }, noLinkConfig);
    }
    const direct = await searchMemories("unlinkedneedle", { ...noLinkConfig, limit: 2 });
    expect(direct).toHaveLength(2);
    expect(direct.every((result) => !result.relatedFrom)).toBe(true);
  });

  test("keeps linked targets inside active-brain and search filters", async () => {
    const home = await tempHome();
    const embedder: EmbeddingProvider = {
      async embed() {
        return [1, 0];
      }
    };
    const main = options(home, embedder);
    const otherBrain = options(home, embedder, "alternate");
    const source = await addMemory(
      {
        type: "workflow",
        text: "filterneedle direct source.",
        metadata: { scope: "deploy", confidence: "high" }
      },
      main
    );
    const eligibleDirect = await addMemory(
      {
        type: "workflow",
        text: "Eligible direct deployment guidance.",
        metadata: { scope: "deploy", confidence: "high" }
      },
      main
    );
    const privateTarget = await addMemory(
      {
        type: "workflow",
        text: "Private deployment guidance.",
        metadata: { scope: "deploy", confidence: "high", sensitivity: "private" }
      },
      main
    );
    const expiredTarget = await addMemory(
      {
        type: "workflow",
        text: "Expired deployment guidance.",
        metadata: { scope: "deploy", confidence: "high", expiresAt: "2026-06-03T00:00:00.000Z" }
      },
      main
    );
    const wrongType = await addMemory(
      {
        type: "decision",
        text: "Decision deployment guidance.",
        metadata: { scope: "deploy", confidence: "high" }
      },
      main
    );
    const wrongScope = await addMemory(
      {
        type: "workflow",
        text: "Other scope deployment guidance.",
        metadata: { scope: "ops", confidence: "high" }
      },
      main
    );
    const lowConfidence = await addMemory(
      {
        type: "workflow",
        text: "Uncertain deployment guidance.",
        metadata: { scope: "deploy", confidence: "low" }
      },
      main
    );
    const episode = await addMemory(
      {
        type: "episode",
        text: "Deployment handoff episode.",
        metadata: { scope: "deploy", confidence: "high" }
      },
      main
    );
    const foreignTarget = await addMemory(
      {
        type: "workflow",
        text: "Other brain deployment guidance.",
        metadata: { scope: "deploy", confidence: "high" }
      },
      otherBrain
    );
    const eligibleRelated = await addMemory(
      {
        type: "workflow",
        text: "Eligible related deployment guidance.",
        metadata: { scope: "deploy", confidence: "high" }
      },
      main
    );
    await updateMemory(
      {
        id: source.id,
        text: source.body,
        metadata: {
          relatedTo: [
            privateTarget.id,
            expiredTarget.id,
            wrongType.id,
            wrongScope.id,
            lowConfidence.id,
            episode.id,
            foreignTarget.id,
            eligibleDirect.id,
            eligibleRelated.id
          ]
        }
      },
      main
    );

    const results = await searchMemories("filterneedle", {
      ...main,
      confidence: "high",
      durableOnly: true,
      limit: 2,
      scope: "deploy",
      type: "workflow"
    });

    expect(results.map((result) => result.id)).toEqual([source.id, eligibleRelated.id]);
    expect(results[1]?.relatedFrom).toBe(source.id);
  });

  test("prompt injection keeps vector-only admission and the shared evidence budget", async () => {
    const home = await tempHome();
    const embedder: EmbeddingProvider = {
      async embed(text) {
        return text.includes("lexical-only") ? [0, 1] : [1, 0];
      }
    };
    const config = options(home, embedder);
    const source = await addMemory(
      { type: "workflow", text: "hookneedle direct source context.", metadata: { confidence: "high" } },
      config
    );
    const lexicalOnly = await addMemory(
      { type: "preference", text: "hookneedle lexical-only context.", metadata: { confidence: "high" } },
      config
    );
    await addMemory(
      { type: "decision", text: "High-confidence direct filler one.", metadata: { confidence: "high" } },
      config
    );
    await addMemory(
      { type: "workspace", text: "High-confidence direct filler two.", metadata: { confidence: "high" } },
      config
    );
    const privateTarget = await addMemory(
      {
        type: "workflow",
        text: "Private hook context.",
        metadata: { confidence: "high", sensitivity: "private" }
      },
      config
    );
    const expiredTarget = await addMemory(
      {
        type: "workflow",
        text: "Expired hook context.",
        metadata: { confidence: "high", expiresAt: "2026-06-03T00:00:00.000Z" }
      },
      config
    );
    const lowConfidence = await addMemory(
      { type: "workflow", text: "Uncertain hook context.", metadata: { confidence: "medium" } },
      config
    );
    const episode = await addMemory(
      { type: "episode", text: "Hook handoff episode.", metadata: { confidence: "high" } },
      config
    );
    const target = await addMemory(
      {
        type: "workflow",
        text: "Linked high-confidence context. " + "T".repeat(9000),
        metadata: { confidence: "high" }
      },
      config
    );
    await updateMemory(
      {
        id: source.id,
        text: source.body,
        metadata: {
          relatedTo: [
            lexicalOnly.id,
            privateTarget.id,
            expiredTarget.id,
            lowConfidence.id,
            episode.id,
            target.id
          ]
        }
      },
      config
    );

    const result = await runUserPromptSubmitHook(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: home, prompt: "hookneedle" }),
      config
    );
    const context = result?.hookSpecificOutput.additionalContext ?? "";

    expect(context).toContain(source.id);
    expect(context).toContain(target.id);
    expect(context).toContain(`related context linked from [${source.id}]`);
    expect(context).toContain("it also matches this request");
    expect(context).not.toContain(lexicalOnly.id);
    expect(context).not.toContain(privateTarget.id);
    expect(context).not.toContain(expiredTarget.id);
    expect(context).not.toContain(lowConfidence.id);
    expect(context).not.toContain(episode.id);
    expect(context).toContain("Incomplete");
    expect(context).not.toContain("T".repeat(9000));
    expect(Buffer.byteLength(context, "utf8")).toBeLessThanOrEqual(8192);
  });
});
