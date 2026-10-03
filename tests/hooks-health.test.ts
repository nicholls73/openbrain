import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { updateConfig } from "../src/config.js";
import { enforceDimensions } from "../src/embeddings.js";
import { addMemory, initOpenBrain, runUserPromptSubmitHook } from "../src/openbrain.js";
import type { EmbeddingProvider, OpenBrainOptions } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(embedder: EmbeddingProvider) {
  const home = await mkdtemp(path.join(tmpdir(), "openbrain-hook-health-"));
  roots.push(home);
  const options: OpenBrainOptions = { home, embedder };
  await initOpenBrain(options);
  return { home, options };
}

function input(cwd: string, prompt = "nonmatching prompt 4938") {
  return JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd, prompt });
}

const WORKING_EMBEDDER: EmbeddingProvider = {
  async embed() {
    return [1, 0];
  }
};

describe("UserPromptSubmit diagnostics", () => {
  test("keeps malformed hook input silent", async () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runUserPromptSubmitHook("{invalid JSON")).toBeUndefined();
    expect(diagnostic).not.toHaveBeenCalled();
  });

  test("keeps provider dimension warnings off hook stdout", async () => {
    const { home, options } = await fixture(enforceDimensions(WORKING_EMBEDDER, 3));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runUserPromptSubmitHook(input(path.join(home, "workspace")), options)).toBeUndefined();
    expect(info).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith(
      "openbrain: semantic embeddings failed; automatic memory injection was skipped."
    );
  });

  test("keeps successful no-match retrieval silent", async () => {
    const { home, options } = await fixture(WORKING_EMBEDDER);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await runUserPromptSubmitHook(input(path.join(home, "workspace")), options);

    expect(result).toBeUndefined();
    expect(diagnostic).not.toHaveBeenCalled();
  });

  test("reports an intentionally unavailable brain without exposing its path", async () => {
    const { home, options } = await fixture(WORKING_EMBEDDER);
    await updateConfig((config) => {
      config.brains.unmatched = "disabled";
    }, options);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const cwd = path.join(home, "private-workspace");

    const result = await runUserPromptSubmitHook(input(cwd), options);

    expect(result).toBeUndefined();
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic.mock.calls[0]?.[0]).toMatch(/memory is disabled for this workspace/i);
    expect(diagnostic.mock.calls[0]?.[0]).not.toContain(cwd);
  });

  test("reports disabled embeddings separately from a healthy no-match", async () => {
    const disabled: EmbeddingProvider = {
      disabled: true,
      async embed() {
        return null;
      }
    };
    const { home, options } = await fixture(disabled);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runUserPromptSubmitHook(input(path.join(home, "workspace")), options);

    expect(result).toBeUndefined();
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic.mock.calls[0]?.[0]).toMatch(/embeddings are disabled/i);
    expect(diagnostic.mock.calls[0]?.[0]).not.toContain("nonmatching prompt 4938");
  });

  test("reports failed embeddings without injecting lexical-only matches or leaking text", async () => {
    let failQuery = false;
    const embedder: EmbeddingProvider = {
      async embed(text) {
        if (failQuery && text.includes("private prompt sentinel")) {
          throw new Error(`raw failure ${text} private memory sentinel`);
        }
        return [1, 0];
      }
    };
    const { home, options } = await fixture(embedder);
    await addMemory(
      {
        type: "workflow",
        text: "Private memory sentinel: release checklist steps.",
        metadata: { confidence: "high" }
      },
      options
    );
    failQuery = true;
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const prompt = "private prompt sentinel: release checklist?";

    const result = await runUserPromptSubmitHook(input(path.join(home, "workspace"), prompt), options);

    expect(result).toBeUndefined();
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic.mock.calls[0]?.[0]).toMatch(/semantic embeddings failed/i);
    expect(diagnostic.mock.calls[0]?.[0]).not.toContain(prompt);
    expect(diagnostic.mock.calls[0]?.[0]).not.toContain("Private memory sentinel");
    expect(diagnostic.mock.calls[0]?.[0]).not.toContain("raw failure");
  });

  test("reports stale stored embedding dimensions without leaking memory content", async () => {
    const query = "outdated embedding checklist";
    const embedder: EmbeddingProvider = {
      async embed(text) {
        return text === query ? [1, 0, 0] : [1, 0];
      }
    };
    const { home, options } = await fixture(embedder);
    await addMemory(
      {
        type: "workflow",
        text: "Private memory sentinel: outdated embedding checklist steps.",
        metadata: { confidence: "high" }
      },
      options
    );
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runUserPromptSubmitHook(input(path.join(home, "workspace"), query), options);

    expect(result).toBeUndefined();
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic.mock.calls[0]?.[0]).toMatch(/outdated embeddings; run "openbrain index rebuild"/i);
    expect(diagnostic.mock.calls[0]?.[0]).not.toContain(query);
    expect(diagnostic.mock.calls[0]?.[0]).not.toContain("Private memory sentinel");
  });

  test("reports retrieval failures with a fixed sanitized diagnostic", async () => {
    const { home, options } = await fixture(WORKING_EMBEDDER);
    const databasePath = path.join(home, "broken-index.sqlite");
    await writeFile(databasePath, "private database sentinel");
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await runUserPromptSubmitHook(input(path.join(home, "workspace")), {
      ...options,
      databasePath
    });

    expect(result).toBeUndefined();
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic.mock.calls[0]?.[0]).toMatch(/memory retrieval failed/i);
    expect(diagnostic.mock.calls[0]?.[0]).not.toContain(home);
    expect(diagnostic.mock.calls[0]?.[0]).not.toContain("private database sentinel");
  });
});
