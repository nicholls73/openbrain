import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  addMemory,
  codexManualGuide,
  promoteMemory,
  runUserPromptSubmitHook,
  searchMemories
} from "../src/openbrain.js";
import type { EmbeddingProvider, OpenBrainOptions } from "../src/types.js";

const homes: string[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

async function tempHome() {
  const home = await mkdtemp(path.join(tmpdir(), "openbrain-confidence-test-"));
  homes.push(home);
  return home;
}

function options(home: string, embedder: EmbeddingProvider): OpenBrainOptions {
  return { home, embedder, now: () => new Date("2026-06-04T09:30:00.000Z") };
}

describe("Codex confidence guidance", () => {
  test("shows that only established high-confidence durable memories are injected", async () => {
    const home = await tempHome();
    const guide = (await codexManualGuide({ home })).replace(/\s+/g, " ");

    expect(guide).toContain("defaults to medium confidence");
    expect(guide).toContain("--confidence high");
    expect(guide).toContain("memory promote");
    expect(guide).toContain("medium confidence");
    expect(guide).toContain("does not make it inject automatically");
  });

  test("stores default durable memories as medium and injects only explicit high-confidence eligible memories", async () => {
    const home = await tempHome();
    const embedder: EmbeddingProvider = {
      async embed(text) {
        return text.toLowerCase().includes("deploy") ? [1, 0] : [0, 1];
      }
    };
    const config = options(home, embedder);
    const defaultMemory = await addMemory(
      { type: "workflow", text: "Deploy with the default confidence checklist." },
      config
    );
    await addMemory(
      {
        type: "workflow",
        text: "Deploy with the established release checklist.",
        metadata: { confidence: "high" }
      },
      config
    );
    await addMemory(
      {
        type: "decision",
        text: "Deploy private credentials only from the vault.",
        metadata: { confidence: "high", sensitivity: "private" }
      },
      config
    );
    await addMemory(
      {
        type: "workflow",
        text: "Deploy with the expired procedure.",
        metadata: { confidence: "high", expiresAt: "2026-06-03T00:00:00.000Z" }
      },
      config
    );
    const episode = await addMemory(
      {
        type: "episode",
        text: "Deploy evidence from a short-lived episode.",
        metadata: { confidence: "high" }
      },
      config
    );
    const promotedMemory = await promoteMemory(
      {
        episodeId: episode.id,
        type: "workflow",
        text: "Deploy from a reviewed promotion candidate."
      },
      config
    );
    await addMemory(
      {
        type: "workflow",
        text: "Rotate the API keys every quarter.",
        metadata: { confidence: "high" }
      },
      config
    );

    expect(defaultMemory.metadata.confidence).toBe("medium");
    expect(promotedMemory.metadata.confidence).toBe("medium");
    const manualResults = await searchMemories("deploy checklist", config);
    expect(manualResults.map((result) => result.id)).toContain(defaultMemory.id);
    expect(manualResults.map((result) => result.id)).toContain(promotedMemory.id);

    const result = await runUserPromptSubmitHook(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        cwd: path.join(home, "workspace"),
        prompt: "How should I deploy with the checklist?"
      }),
      config
    );
    const context = result?.hookSpecificOutput.additionalContext ?? "";

    expect(context).toContain("Deploy with the established release checklist.");
    expect(context).not.toContain("Deploy with the default confidence checklist.");
    expect(context).not.toContain("Deploy private credentials");
    expect(context).not.toContain("Deploy with the expired procedure.");
    expect(context).not.toContain("Deploy evidence from a short-lived episode.");
    expect(context).not.toContain("Deploy from a reviewed promotion candidate.");
    expect(context).not.toContain("Rotate the API keys every quarter.");
    expect(context).not.toContain(home);
  });
});
