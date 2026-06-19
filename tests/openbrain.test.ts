import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  addMemory,
  addBrainPath,
  deleteMemory,
  dreamMaybe,
  dreamRun,
  initOpenBrain,
  getCurrentBrain,
  listMemories,
  pruneEpisodes,
  rebuildIndex,
  searchMemories,
  showMemory,
  setupOpenBrain,
  syncCodexAgent
} from "../src/openbrain.js";
import type { EmbeddingProvider, OpenBrainOptions } from "../src/types.js";

const tempRoots: string[] = [];
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
  test("uses a stable SQLite dependency instead of Node experimental sqlite", async () => {
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const dbSource = await readFile(path.join(repoRoot, "src", "db.ts"), "utf8");

    expect(packageJson.dependencies).toHaveProperty("better-sqlite3");
    expect(dbSource).not.toContain("node:sqlite");
  });

  test("init creates folders, config, and SQLite database", async () => {
    const home = await tempHome();

    await initOpenBrain(options(home));

    await expect(readFile(path.join(home, "config.json"), "utf8")).resolves.toContain(
      "\"retentionDays\": 30"
    );
    await expect(readFile(path.join(home, "brains", "main", "openbrain.db"))).resolves.toBeInstanceOf(Buffer);
  });

  test("selects isolated brains from configured current working directory paths", async () => {
    const home = await tempHome();
    const projectA = path.join(home, "projects", "alpha", "repo");
    const projectB = path.join(home, "projects", "beta", "repo");
    await initOpenBrain(options(home));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify(
        {
          brains: {
            default: "main",
            pathRules: [
              {
                brain: "alpha",
                paths: [path.join(home, "projects", "alpha")]
              },
              {
                brain: "beta",
                paths: [path.join(home, "projects", "beta")]
              }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const alphaMemory = await addMemory(
      {
        type: "project",
        text: "The alpha brain remembers release planning context."
      },
      { ...options(home), cwd: projectA }
    );
    await addMemory(
      {
        type: "project",
        text: "The beta brain remembers prototype sketch context."
      },
      { ...options(home), cwd: projectB }
    );

    expect(alphaMemory.path).toContain(path.join("brains", "alpha", "memories"));
    expect(await searchMemories("release planning", { ...options(home), cwd: projectA })).toHaveLength(1);
    expect(await searchMemories("release planning", { ...options(home), cwd: projectB })).toHaveLength(0);
    expect(await searchMemories("prototype", { ...options(home), cwd: projectA })).toHaveLength(0);
    expect(await getCurrentBrain({ ...options(home), cwd: projectA })).toBe("alpha");
    expect(await getCurrentBrain({ ...options(home), cwd: projectB })).toBe("beta");
  });

  test("can disable OpenBrain for paths that do not match a brain rule", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify(
        {
          brains: {
            default: "main",
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
    const projectPath = path.join(home, "new-project");
    await initOpenBrain(options(home));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify(
        {
          brains: {
            default: "main",
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

    await addBrainPath("alpha", projectPath, options(home));
    expect(await getCurrentBrain({ ...options(home), cwd: projectPath })).toBe("alpha");
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
            default: "main",
            pathRules: [
              {
                brain: "alpha",
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

    expect(await getCurrentBrain({ ...options(home), cwd: path.join(realRoot, "repo") })).toBe("alpha");
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

  test("guided setup can keep one default brain and sync Codex instructions", async () => {
    const home = await tempHome();
    const codexHome = path.join(home, ".codex");

    const result = await setupOpenBrain(
      {
        brainScope: "default",
        syncCodex: true
      },
      { ...options(home), codexHome }
    );
    const config = await loadConfig(options(home));

    expect(config.brains).toMatchObject({
      default: "main",
      unmatched: "default",
      pathRules: []
    });
    expect(result).toMatchObject({
      brainScope: "default",
      currentBrain: "main",
      codexAgentFile: path.join(codexHome, "AGENTS.md")
    });
    await expect(readFile(path.join(codexHome, "AGENTS.md"), "utf8")).resolves.toContain(
      "BEGIN OPENBRAIN"
    );
  });

  test("guided setup can configure path-specific brains and ask on unmatched paths", async () => {
    const home = await tempHome();
    const projectPath = path.join(home, "projects", "alpha");

    const result = await setupOpenBrain(
      {
        brainScope: "paths",
        pathRules: [
          {
            brain: "Brain A",
            path: projectPath
          }
        ],
        syncCodex: false
      },
      options(home)
    );
    const config = await loadConfig(options(home));

    expect(config.brains.unmatched).toBe("ask");
    expect(config.brains.pathRules).toEqual([
      {
        brain: "brain-a",
        paths: [projectPath]
      }
    ]);
    expect(result).toMatchObject({
      brainScope: "paths",
      currentBrain: "brain-a",
      pathRules: [
        {
          brain: "brain-a",
          path: projectPath
        }
      ]
    });
    expect(await getCurrentBrain({ ...options(home), cwd: projectPath })).toBe("brain-a");
    expect(await getCurrentBrain({ ...options(home), cwd: path.join(home, "unmatched") })).toBe("ask:main");
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

    await rm(path.join(home, "brains", "main", "openbrain.db"), { force: true });
    await rebuildIndex(options(home));
    expect((await searchMemories("canonical memory", options(home)))[0]?.id).toBe(added.id);

    await deleteMemory(added.id, options(home));
    expect(await listMemories(options(home))).toHaveLength(0);
    expect(await searchMemories("canonical memory", options(home))).toHaveLength(0);
  });

  test("rebuild embeds each memory exactly once with a shared embedder", async () => {
    const home = await tempHome();
    let embedCalls = 0;
    const embedder: EmbeddingProvider = {
      async embed() {
        embedCalls += 1;
        return [1, 0, 0];
      }
    };
    await initOpenBrain(options(home, embedder));
    await addMemory({ type: "workflow", text: "first durable memory" }, options(home, embedder));
    await addMemory({ type: "decision", text: "second durable memory" }, options(home, embedder));

    embedCalls = 0;
    await rebuildIndex(options(home, embedder));

    expect(embedCalls).toBe(2);
  });

  test("prune removes old episode logs without deleting durable memories", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    await addMemory({ type: "workflow", text: "Durable workflow memory stays." }, options(home));
    const oldEpisode = path.join(home, "brains", "main", "episodes", "2026-01-01-old.md");
    await writeFile(oldEpisode, "old session", "utf8");

    const pruned = await pruneEpisodes(options(home));

    expect(pruned).toContain(oldEpisode);
    expect(await listMemories(options(home))).toHaveLength(1);
    await expect(readFile(oldEpisode, "utf8")).rejects.toThrow();
  });

  test("dream run records state, writes an audit log, prunes episodes, and rebuilds the index", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    const added = await addMemory(
      {
        type: "decision",
        text: "Dreaming consolidates memory without inventing facts."
      },
      options(home)
    );
    await rm(path.join(home, "brains", "main", "openbrain.db"), { force: true });
    const oldEpisode = path.join(home, "brains", "main", "episodes", "2026-01-01-old.md");
    await writeFile(oldEpisode, "old session", "utf8");

    const result = await dreamRun(options(home));

    expect(result).toMatchObject({
      brain: "main",
      status: "ran",
      date: "2026-06-04",
      prunedEpisodes: 1,
      rebuiltIndex: true
    });
    await expect(readFile(path.join(home, "brains", "main", "dreams", "state.json"), "utf8")).resolves.toContain(
      "\"lastDreamDate\": \"2026-06-04\""
    );
    await expect(readFile(result.logPath, "utf8")).resolves.toContain("Dream run");
    await expect(readFile(oldEpisode, "utf8")).rejects.toThrow();
    expect((await searchMemories("inventing facts", options(home)))[0]?.id).toBe(added.id);
  });

  test("dream maybe runs only once per brain each day", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));

    const first = await dreamMaybe(options(home));
    const second = await dreamMaybe(options(home));
    const nextDay = await dreamMaybe({
      ...options(home),
      now: () => new Date("2026-06-05T09:30:00.000Z")
    });

    expect(first.status).toBe("ran");
    expect(second).toMatchObject({
      brain: "main",
      status: "skipped",
      reason: "already-dreamed-today",
      date: "2026-06-04"
    });
    expect(nextDay.status).toBe("ran");
    const dreamFiles = await readdir(path.join(home, "brains", "main", "dreams"));
    expect(dreamFiles.filter((file) => file.endsWith(".md"))).toHaveLength(2);
  });
});

describe("Codex adapter sync", () => {
  test("frames memory as belonging to the active brain, not a repo or project", async () => {
    const home = await tempHome();
    const codexHome = path.join(home, ".codex");
    await initOpenBrain(options(home));

    await syncCodexAgent({ ...options(home), codexHome });
    const agentFile = await readFile(path.join(codexHome, "AGENTS.md"), "utf8");

    expect(agentFile).toContain("OpenBrain uses the current workspace path only to choose the active brain.");
    expect(agentFile).toContain("Treat that brain as the memory container.");
    expect(agentFile).toContain("Refer to memory by brain name or");
    expect(agentFile).toContain("active brain. Refer to paths only when configuring brain routing or discussing");
    expect(agentFile).toContain('openbrain brain add-path <brain> "<current workspace path>"');
    expect(agentFile).toContain('openbrain memory add --type workspace --text "..."');
    expect(agentFile).toContain("Record durable memories only when the guidance is likely to stay useful");
    expect(agentFile).toContain("Do not store branch names, PR");
    expect(agentFile).toContain("If short-lived handoff context is useful, store it as");
    expect(agentFile).toContain("For POC or reference work, classify details before storing them.");
    expect(agentFile).toContain("- `workspace`: stable workspace, toolchain, or recurring task conventions.");
    expect(agentFile).toContain("- `episode`: short-lived session notes, handoff state, or fast-changing facts.");
    expect(agentFile).not.toContain("<current project path>");
    expect(agentFile).not.toContain("repo or tooling conventions");
    expect(agentFile).not.toContain("openbrain memory add --type project --text");
    expect(agentFile).not.toMatch(/\brepo\b/i);
    expect(agentFile).not.toMatch(/\bproject\b/i);
  });

  test("inserts and updates only the marked OpenBrain block", async () => {
    const home = await tempHome();
    const codexHome = path.join(home, ".codex");
    await initOpenBrain(options(home));

    await syncCodexAgent({ ...options(home), codexHome });
    const first = await readFile(path.join(codexHome, "AGENTS.md"), "utf8");
    expect(first).toContain("BEGIN OPENBRAIN");
    expect(first).toContain("openbrain dream maybe --quiet");
    expect(first).toContain("openbrain memory search");
    expect(first.indexOf("openbrain dream maybe --quiet")).toBeLessThan(first.indexOf("openbrain memory search"));

    await writeFile(
      path.join(codexHome, "AGENTS.md"),
      `# Existing rules\n\nDo not remove this.\n\n${first}`,
      "utf8"
    );
    await syncCodexAgent({ ...options(home), codexHome });
    const second = await readFile(path.join(codexHome, "AGENTS.md"), "utf8");

    expect(second).toContain("Do not remove this.");
    expect(second.match(/BEGIN OPENBRAIN/g)).toHaveLength(1);
  });
});
