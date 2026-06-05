import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  addMemory,
  addBrainPath,
  deleteMemory,
  initOpenBrain,
  getCurrentBrain,
  listMemories,
  pruneEpisodes,
  rebuildIndex,
  searchMemories,
  showMemory,
  syncCodexAgent
} from "../src/openbrain.js";
import type { EmbeddingProvider, OpenBrainOptions } from "../src/types.js";

const tempRoots: string[] = [];

async function tempHome() {
  const root = await mkdtemp(path.join(tmpdir(), "openbrain-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function options(home: string, embedder?: EmbeddingProvider): OpenBrainOptions {
  return {
    home,
    now: () => new Date("2026-06-04T09:30:00.000Z"),
    embedder
  };
}

describe("OpenBrain local storage", () => {
  test("init creates folders, config, and SQLite database", async () => {
    const home = await tempHome();

    await initOpenBrain(options(home));

    await expect(readFile(path.join(home, "config.json"), "utf8")).resolves.toContain(
      "\"retentionDays\": 30"
    );
    await expect(readFile(path.join(home, "brains", "personal", "openbrain.db"))).resolves.toBeInstanceOf(Buffer);
  });

  test("selects isolated brains from configured current working directory paths", async () => {
    const home = await tempHome();
    const workProject = path.join(home, "projects", "work", "repo");
    const personalProject = path.join(home, "projects", "personal", "repo");
    await initOpenBrain(options(home));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify(
        {
          brains: {
            default: "personal",
            pathRules: [
              {
                brain: "work",
                paths: [path.join(home, "projects", "work")]
              },
              {
                brain: "personal",
                paths: [path.join(home, "projects", "personal")]
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const workMemory = await addMemory(
      {
        type: "project",
        text: "The work brain remembers enterprise repository context."
      },
      { ...options(home), cwd: workProject }
    );
    await addMemory(
      {
        type: "project",
        text: "The personal brain remembers hobby project context."
      },
      { ...options(home), cwd: personalProject }
    );

    expect(workMemory.path).toContain(path.join("brains", "work", "memories"));
    expect(await searchMemories("enterprise repository", { ...options(home), cwd: workProject })).toHaveLength(1);
    expect(await searchMemories("enterprise repository", { ...options(home), cwd: personalProject })).toHaveLength(0);
    expect(await searchMemories("hobby", { ...options(home), cwd: workProject })).toHaveLength(0);
    expect(await getCurrentBrain({ ...options(home), cwd: workProject })).toBe("work");
    expect(await getCurrentBrain({ ...options(home), cwd: personalProject })).toBe("personal");
  });

  test("can disable OpenBrain for paths that do not match a brain rule", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify(
        {
          brains: {
            default: "personal",
            unmatched: "disabled",
            pathRules: []
          }
        },
        null,
        2
      ),
      "utf8"
    );

    await expect(
      addMemory(
        {
          type: "project",
          text: "This should not be stored when OpenBrain is disabled for this path."
        },
        { ...options(home), cwd: path.join(home, "unknown", "repo") }
      )
    ).rejects.toThrow("disabled for this path");
  });

  test("can ask the agent to add unmatched paths before using OpenBrain", async () => {
    const home = await tempHome();
    const projectPath = path.join(home, "new-work-project");
    await initOpenBrain(options(home));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify(
        {
          brains: {
            default: "personal",
            unmatched: "ask",
            pathRules: []
          }
        },
        null,
        2
      ),
      "utf8"
    );

    await expect(searchMemories("deployment", { ...options(home), cwd: projectPath })).rejects.toThrow(
      "Ask the user which brain"
    );

    await addBrainPath("work", projectPath, options(home));
    expect(await getCurrentBrain({ ...options(home), cwd: projectPath })).toBe("work");
  });

  test("matches path rules when cwd and config use different symlink spellings", async () => {
    const home = await tempHome();
    const symlinkRoot = await mkdtemp(path.join("/tmp", "openbrain-path-rule-"));
    tempRoots.push(symlinkRoot);
    const realRoot = await realpath(symlinkRoot);
    await initOpenBrain(options(home));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify(
        {
          brains: {
            default: "personal",
            pathRules: [
              {
                brain: "work",
                paths: [symlinkRoot]
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    expect(await getCurrentBrain({ ...options(home), cwd: path.join(realRoot, "repo") })).toBe("work");
  });

  test("loads partial nested config without dropping defaults", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify(
        {
          embeddings: {
            model: "local/custom-embedding-model"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const config = await loadConfig(options(home));

    expect(config.embeddings).toMatchObject({
      enabled: true,
      model: "local/custom-embedding-model",
      dimensions: 384,
      timeoutMs: 5000
    });
    expect(config.retrieval.limit).toBe(5);
    expect(config.agents.codex.enabled).toBe(true);
  });

  test("adds Markdown memories and finds them through FTS", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));

    const added = await addMemory(
      {
        type: "workflow",
        text: "When Copilot leaves PR review comments, address them before asking to merge."
      },
      options(home)
    );

    expect(added.id).toMatch(/^2026-06-04-/);
    await expect(readFile(added.path, "utf8")).resolves.toContain("Copilot leaves PR review");

    const results = await searchMemories("Copilot review", options(home));

    expect(results[0]).toMatchObject({
      id: added.id,
      type: "workflow",
      title: "When Copilot leaves PR review comments"
    });
    expect(results[0].excerpt).toContain("Copilot");
  });

  test("uses vector results when query wording differs from memory wording", async () => {
    const home = await tempHome();
    const embedder: EmbeddingProvider = {
      async embed(text: string) {
        return text.toLowerCase().includes("feedback") || text.toLowerCase().includes("comments")
          ? [1, 0, 0]
          : [0, 1, 0];
      }
    };
    await initOpenBrain(options(home, embedder));
    await addMemory(
      {
        type: "workflow",
        text: "When Copilot feedback appears on a PR, finish those requested changes first."
      },
      options(home, embedder)
    );

    const results = await searchMemories("review comments", options(home, embedder));

    expect(results[0]?.title).toBe("When Copilot feedback appears on a PR");
    expect(results[0]?.match).toBe("vector");
  });

  test("falls back to FTS when embeddings fail", async () => {
    const home = await tempHome();
    const failingEmbedder: EmbeddingProvider = {
      async embed() {
        throw new Error("embedding unavailable");
      }
    };
    await initOpenBrain(options(home, failingEmbedder));
    const added = await addMemory(
      {
        type: "preference",
        text: "James prefers pnpm over npm for TypeScript projects."
      },
      options(home, failingEmbedder)
    );

    const results = await searchMemories("pnpm TypeScript", options(home, failingEmbedder));

    expect(results[0]?.id).toBe(added.id);
    expect(results[0]?.match).toBe("fts");
  });

  test("list, show, delete, and rebuild operate from Markdown source of truth", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    const added = await addMemory(
      {
        type: "decision",
        text: "OpenBrain keeps Markdown files as the canonical memory source."
      },
      options(home)
    );

    expect(await listMemories(options(home))).toHaveLength(1);
    await expect(showMemory(added.id, options(home))).resolves.toContain("canonical memory source");

    await rm(path.join(home, "brains", "personal", "openbrain.db"), { force: true });
    await rebuildIndex(options(home));
    expect((await searchMemories("canonical memory", options(home)))[0]?.id).toBe(added.id);

    await deleteMemory(added.id, options(home));
    expect(await listMemories(options(home))).toHaveLength(0);
    expect(await searchMemories("canonical memory", options(home))).toHaveLength(0);
  });

  test("prune removes old episode logs without deleting durable memories", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    await addMemory({ type: "workflow", text: "Durable workflow memory stays." }, options(home));
    const oldEpisode = path.join(home, "brains", "personal", "episodes", "2026-01-01-old.md");
    await writeFile(oldEpisode, "old session", "utf8");

    const pruned = await pruneEpisodes(options(home));

    expect(pruned).toContain(oldEpisode);
    expect(await listMemories(options(home))).toHaveLength(1);
    await expect(readFile(oldEpisode, "utf8")).rejects.toThrow();
  });
});

describe("Codex adapter sync", () => {
  test("inserts and updates only the marked OpenBrain block", async () => {
    const home = await tempHome();
    const codexHome = path.join(home, ".codex");
    await initOpenBrain(options(home));

    await syncCodexAgent({ ...options(home), codexHome });
    const first = await readFile(path.join(codexHome, "AGENTS.md"), "utf8");
    expect(first).toContain("BEGIN OPENBRAIN");
    expect(first).toContain("openbrain memory search");

    await writeFile(
      path.join(codexHome, "AGENTS.md"),
      `# Personal rules\n\nDo not remove this.\n\n${first}`,
      "utf8"
    );
    await syncCodexAgent({ ...options(home), codexHome });
    const second = await readFile(path.join(codexHome, "AGENTS.md"), "utf8");

    expect(second).toContain("Do not remove this.");
    expect(second.match(/BEGIN OPENBRAIN/g)).toHaveLength(1);
  });
});
