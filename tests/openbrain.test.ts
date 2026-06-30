import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  isSqliteNodeAbiMismatch,
  openDatabase,
  openSqliteDatabase,
  sqliteNativeModuleRecoveryMessage
} from "../src/db.js";
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
  promoteMemory,
  rebuildIndex,
  runSessionStartHook,
  searchMemories,
  showMemory,
  setupOpenBrain,
  syncClaudeAgent,
  syncClaudeSettings,
  syncCodexAgent
} from "../src/openbrain.js";
import type { EmbeddingProvider, OpenBrainOptions } from "../src/types.js";
import { isMemoryType, isStoredMemoryType } from "../src/types.js";

const tempRoots: string[] = [];
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

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

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, { cwd });
}

async function createWorktreeFixture(home: string, name = "feature") {
  const source = path.join(home, "projects", "repo");
  const worktree = path.join(home, "projects", `repo-${name}`);
  await mkdir(source, { recursive: true });
  await git(source, ["init"]);
  await git(source, ["config", "user.name", "OpenBrain Test"]);
  await git(source, ["config", "user.email", "openbrain@example.test"]);
  await writeFile(path.join(source, "README.md"), "fixture\n", "utf8");
  await git(source, ["add", "README.md"]);
  await git(source, ["commit", "-m", "init"]);
  await git(source, ["worktree", "add", "-b", name, worktree]);
  return {
    source: await realpath(source),
    worktree: await realpath(worktree)
  };
}

async function readPathRules(home: string) {
  return (await loadConfig(options(home))).brains.pathRules;
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

  test("explains how to recover from a better-sqlite3 Node ABI mismatch", () => {
    expect(
      isSqliteNodeAbiMismatch(
        new Error(
          "better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 137"
        )
      )
    ).toBe(true);
    expect(sqliteNativeModuleRecoveryMessage()).toContain("pnpm rebuild better-sqlite3");
    expect(sqliteNativeModuleRecoveryMessage()).toContain("default install");
    expect(sqliteNativeModuleRecoveryMessage()).toContain("OPENBRAIN_INSTALL_DIR");
  });

  test("wraps better-sqlite3 constructor ABI mismatch errors", () => {
    const abiError = new Error(
      "better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 137"
    );
    const ThrowingDatabase = class {
      constructor(_file: string) {
        throw abiError;
      }
    };

    expect(() => openSqliteDatabase("openbrain.db", ThrowingDatabase as never)).toThrow(
      sqliteNativeModuleRecoveryMessage()
    );
    try {
      openSqliteDatabase("openbrain.db", ThrowingDatabase as never);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBe(abiError);
    }
  });

  test("init creates folders, config, and SQLite database", async () => {
    const home = await tempHome();

    await initOpenBrain(options(home));

    await expect(readFile(path.join(home, "config.json"), "utf8")).resolves.toContain(
      "\"retentionDays\": 30"
    );
    await expect(readFile(path.join(home, "brains", "main", "openbrain.db"))).resolves.toBeInstanceOf(Buffer);
  });

  test("opens the database in WAL mode with a busy timeout for concurrent agents", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));

    const db = await openDatabase({ home, brain: "main" });
    try {
      expect(String(db.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    } finally {
      db.close();
    }
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

  test("inherits source brain for an unmapped git worktree", async () => {
    const home = await tempHome();
    const { source, worktree } = await createWorktreeFixture(home);
    await initOpenBrain(options(home));
    await addBrainPath("work", source, options(home));

    expect(await getCurrentBrain({ ...options(home), cwd: worktree })).toBe("work");
  });

  test("persists inherited worktree routing to path rules", async () => {
    const home = await tempHome();
    const { source, worktree } = await createWorktreeFixture(home);
    await initOpenBrain(options(home));
    await addBrainPath("work", source, options(home));

    await getCurrentBrain({ ...options(home), cwd: worktree });

    expect(await readPathRules(home)).toEqual([
      {
        brain: "work",
        paths: [source, worktree]
      }
    ]);
  });

  test("session hook reports active inherited brain from a worktree", async () => {
    const home = await tempHome();
    const { source, worktree } = await createWorktreeFixture(home);
    await initOpenBrain(options(home));
    await addBrainPath("work", source, options(home));

    await expect(runSessionStartHook({ ...options(home), cwd: worktree })).resolves.toContain(
      "OpenBrain memory is active (brain: work)."
    );
  });

  test("explicit worktree mapping wins over source brain inheritance", async () => {
    const home = await tempHome();
    const { source, worktree } = await createWorktreeFixture(home);
    await initOpenBrain(options(home));
    await addBrainPath("work", source, options(home));
    await addBrainPath("experiment", worktree, options(home));

    expect(await getCurrentBrain({ ...options(home), cwd: worktree })).toBe("experiment");
    expect(await readPathRules(home)).toEqual([
      {
        brain: "work",
        paths: [source]
      },
      {
        brain: "experiment",
        paths: [worktree]
      }
    ]);
  });

  test("later source mapping changes do not overwrite explicit worktree mapping", async () => {
    const home = await tempHome();
    const { source, worktree } = await createWorktreeFixture(home);
    await initOpenBrain(options(home));
    await addBrainPath("work", source, options(home));
    await addBrainPath("experiment", worktree, options(home));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify(
        {
          brains: {
            default: "main",
            unmatched: "ask",
            pathRules: [
              { brain: "other", paths: [source] },
              { brain: "experiment", paths: [worktree] }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    expect(await getCurrentBrain({ ...options(home), cwd: worktree })).toBe("experiment");
    expect(await readPathRules(home)).toEqual([
      { brain: "other", paths: [source] },
      { brain: "experiment", paths: [worktree] }
    ]);
  });

  test("brain add-path remaps a previously inherited worktree path", async () => {
    const home = await tempHome();
    const { source, worktree } = await createWorktreeFixture(home);
    await initOpenBrain(options(home));
    await addBrainPath("work", source, options(home));
    await getCurrentBrain({ ...options(home), cwd: worktree });

    await addBrainPath("experiment", worktree, options(home));

    expect(await getCurrentBrain({ ...options(home), cwd: worktree })).toBe("experiment");
    expect(await readPathRules(home)).toEqual([
      { brain: "work", paths: [source] },
      { brain: "experiment", paths: [worktree] }
    ]);
  });

  test("ambiguous source mappings leave worktree unmapped and ask the user", async () => {
    const home = await tempHome();
    const { source, worktree } = await createWorktreeFixture(home);
    await initOpenBrain(options(home));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify(
        {
          brains: {
            default: "main",
            unmatched: "ask",
            pathRules: [
              { brain: "alpha", paths: [source] },
              { brain: "beta", paths: [source] }
            ]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    expect(await getCurrentBrain({ ...options(home), cwd: worktree })).toBe("ask:main");
    await expect(searchMemories("routing", { ...options(home), cwd: worktree })).rejects.toThrow(
      "Ask the user which brain"
    );
    expect(await readPathRules(home)).toEqual([
      { brain: "alpha", paths: [source] },
      { brain: "beta", paths: [source] }
    ]);
  });

  test("unmapped worktree source follows unmatched path behavior", async () => {
    const defaultHome = await tempHome();
    const { worktree: defaultWorktree } = await createWorktreeFixture(defaultHome);
    await initOpenBrain(options(defaultHome));
    expect(await getCurrentBrain({ ...options(defaultHome), cwd: defaultWorktree })).toBe("main");

    const askHome = await tempHome();
    const { worktree: askWorktree } = await createWorktreeFixture(askHome);
    await initOpenBrain(options(askHome));
    await writeFile(
      path.join(askHome, "config.json"),
      JSON.stringify({ brains: { default: "main", unmatched: "ask", pathRules: [] } }, null, 2),
      "utf8"
    );
    expect(await getCurrentBrain({ ...options(askHome), cwd: askWorktree })).toBe("ask:main");
    await expect(runSessionStartHook({ ...options(askHome), cwd: askWorktree })).resolves.toContain(
      "OpenBrain has no brain assigned"
    );

    const disabledHome = await tempHome();
    const { worktree: disabledWorktree } = await createWorktreeFixture(disabledHome);
    await initOpenBrain(options(disabledHome));
    await writeFile(
      path.join(disabledHome, "config.json"),
      JSON.stringify({ brains: { default: "main", unmatched: "disabled", pathRules: [] } }, null, 2),
      "utf8"
    );
    expect(await getCurrentBrain({ ...options(disabledHome), cwd: disabledWorktree })).toBe("disabled:main");
    await expect(runSessionStartHook({ ...options(disabledHome), cwd: disabledWorktree })).resolves.toContain(
      "OpenBrain is disabled"
    );
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
    expect(config.agents.claude.enabled).toBe(true);
  });

  test("guided setup can keep one default brain and sync agent instructions", async () => {
    const home = await tempHome();
    const codexHome = path.join(home, ".codex");
    const claudeHome = path.join(home, ".claude");

    const result = await setupOpenBrain(
      {
        brainScope: "default",
        syncCodex: true,
        syncClaude: true
      },
      { ...options(home), codexHome, claudeHome }
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
      codexAgentFile: path.join(codexHome, "AGENTS.md"),
      claudeAgentFile: path.join(claudeHome, "CLAUDE.md")
    });
    await expect(readFile(path.join(codexHome, "AGENTS.md"), "utf8")).resolves.toContain(
      "BEGIN OPENBRAIN"
    );
    await expect(readFile(path.join(claudeHome, "CLAUDE.md"), "utf8")).resolves.toContain(
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

  test("renders metadata frontmatter and returns indexed metadata", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));

    const added = await addMemory(
      {
        type: "episode",
        text: "Build handoff found flaky deploy validation.",
        metadata: {
          source: "user",
          scope: "handoff",
          confidence: "high",
          sensitivity: "private",
          promoteAs: "workflow"
        }
      },
      options(home)
    );

    const raw = await readFile(added.path, "utf8");
    expect(raw).toContain("source: user");
    expect(raw).toContain("scope: handoff");
    expect(raw).toContain("confidence: high");
    expect(raw).toContain("sensitivity: private");
    expect(raw).toContain("promoteAs: workflow");
    expect(raw).toContain("expiresAt: 2026-07-04T09:30:00.000Z");

    const results = await searchMemories("flaky deploy", { ...options(home), includePrivate: true });
    expect(results[0]).toMatchObject({
      id: added.id,
      source: "user",
      scope: "handoff",
      confidence: "high",
      sensitivity: "private",
      promoteAs: "workflow"
    });
  });

  test("filters search by metadata and hides expired and private records by default", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    await addMemory(
      {
        type: "workflow",
        text: "Deploy memory for durable workflow search.",
        metadata: { scope: "release", confidence: "high" }
      },
      options(home)
    );
    await addMemory(
      {
        type: "episode",
        text: "Deploy memory for temporary episode search.",
        metadata: { expiresAt: "2026-01-01T00:00:00.000Z" }
      },
      options(home)
    );
    await addMemory(
      {
        type: "decision",
        text: "Deploy memory for private decision search.",
        metadata: { sensitivity: "private" }
      },
      options(home)
    );

    expect((await searchMemories("deploy memory", options(home))).map((result) => result.type)).toEqual([
      "workflow"
    ]);
    expect(
      (await searchMemories("deploy memory", { ...options(home), scope: "release", confidence: "high" }))[0]
        ?.type
    ).toBe("workflow");
    expect(
      await searchMemories("deploy memory", {
        ...options(home),
        type: "decision",
        includePrivate: true
      })
    ).toHaveLength(1);
    expect(await searchMemories("deploy memory", { ...options(home), durableOnly: true })).toHaveLength(1);
  });

  test("keeps frontmatter-less episodes searchable until filename-based pruning removes them", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    const rawEpisode = path.join(home, "brains", "main", "episodes", "2026-06-04-raw-note.md");
    await writeFile(rawEpisode, "Raw session note mentions deployment callbacks.", "utf8");

    await rebuildIndex(options(home));

    const results = await searchMemories("deployment callbacks", options(home));
    expect(results[0]).toMatchObject({
      id: "2026-06-04-raw-note",
      type: "episode",
      expiresAt: undefined
    });
  });

  test("warns and defaults invalid metadata instead of silently dropping it", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const invalid = path.join(home, "brains", "main", "episodes", "2026-06-04-invalid.md");
      await writeFile(
        invalid,
        [
          "---",
          "id: 2026-06-04-invalid",
          "type: episode",
          "title: Invalid metadata",
          "createdAt: 2026-06-04T09:30:00.000Z",
          "confidence: certain",
          "sensitivity: secret",
          "expiresAt: tomorrow",
          "promoteAs: habit",
          "---",
          "",
          "Invalid metadata still indexes with defaults.",
          ""
        ].join("\n"),
        "utf8"
      );

      await rebuildIndex(options(home));

      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("ignored invalid confidence");
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("ignored invalid sensitivity");
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("ignored invalid expiresAt");
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("ignored invalid promoteAs");
      expect((await searchMemories("invalid metadata", options(home)))[0]).toMatchObject({
        confidence: "low",
        sensitivity: "standard",
        promoteAs: undefined
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("warns when promoteAs is ignored for durable memories", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const added = await addMemory(
        {
          type: "workflow",
          text: "Durable workflows cannot be promotion candidates.",
          metadata: { promoteAs: "decision" }
        },
        options(home)
      );

      expect(String(warn.mock.calls[0]?.[0])).toContain("ignored promoteAs");
      await expect(readFile(added.path, "utf8")).resolves.not.toContain("promoteAs:");
    } finally {
      warn.mockRestore();
    }
  });

  test("does not embed private memories", async () => {
    const home = await tempHome();
    let embedCalls = 0;
    const embedder: EmbeddingProvider = {
      async embed() {
        embedCalls += 1;
        return [1, 0, 0];
      }
    };
    await initOpenBrain(options(home, embedder));

    await addMemory(
      {
        type: "workflow",
        text: "Private workflow memory should stay local only.",
        metadata: { sensitivity: "private" }
      },
      options(home, embedder)
    );
    expect(embedCalls).toBe(0);

    await addMemory(
      {
        type: "workflow",
        text: "Standard workflow memory can be embedded."
      },
      options(home, embedder)
    );
    expect(embedCalls).toBe(1);
  });

  test("promotes an episode into durable memory without deleting the source episode", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    const episode = await addMemory(
      {
        type: "episode",
        text: "Review handoff says deployment comments should be handled first.",
        metadata: { source: "user", sensitivity: "private", promoteAs: "workflow" }
      },
      options(home)
    );

    const promoted = await promoteMemory(
      {
        episodeId: episode.id,
        type: "workflow",
        text: "Handle deployment review comments before asking to merge."
      },
      options(home)
    );

    expect(promoted.type).toBe("workflow");
    expect(promoted.metadata).toMatchObject({
      source: "user",
      promotedFrom: episode.id,
      sensitivity: "private"
    });
    await expect(showMemory(episode.id, options(home))).resolves.toContain("Review handoff");
    await expect(showMemory(promoted.id, options(home))).resolves.toContain(`promotedFrom: ${episode.id}`);
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

  test("skips stored embeddings whose dimensions no longer match the model", async () => {
    const home = await tempHome();
    const wideEmbedder: EmbeddingProvider = {
      async embed() {
        return [1, 0, 0];
      }
    };
    await initOpenBrain(options(home, wideEmbedder));
    const added = await addMemory(
      { type: "preference", text: "James prefers pnpm for TypeScript projects." },
      options(home, wideEmbedder)
    );

    const narrowEmbedder: EmbeddingProvider = {
      async embed() {
        return [1, 0];
      }
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const results = await searchMemories("pnpm TypeScript", options(home, narrowEmbedder));

      expect(results[0]?.id).toBe(added.id);
      expect(results[0]?.match).toBe("fts");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("index rebuild");
    } finally {
      warn.mockRestore();
    }
  });

  test("fuses FTS and vector hits with reciprocal rank fusion", async () => {
    const home = await tempHome();
    const embedder: EmbeddingProvider = {
      async embed(text: string) {
        return text.toLowerCase().includes("deploy") ? [1, 0, 0] : [0, 1, 0];
      }
    };
    await initOpenBrain(options(home, embedder));
    const both = await addMemory(
      { type: "workflow", text: "Deploy pipeline runbook for staging releases." },
      options(home, embedder)
    );
    await addMemory(
      { type: "workflow", text: "Unrelated note about cat feeding schedule." },
      options(home, embedder)
    );

    const results = await searchMemories("deploy", options(home, embedder));

    expect(results[0]?.id).toBe(both.id);
    expect(results[0]?.match).toBe("hybrid");
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

  test("legacy project memories rebuild from Markdown but are not writable memory types", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    const legacyPath = path.join(home, "brains", "main", "memories", "2026-01-01-legacy-project.md");
    await writeFile(
      legacyPath,
      [
        "---",
        "id: 2026-01-01-legacy-project",
        "type: project",
        "title: Legacy project convention",
        "createdAt: 2026-01-01T00:00:00.000Z",
        "---",
        "",
        "Legacy project memory remains searchable after rebuild.",
        ""
      ].join("\n"),
      "utf8"
    );

    await rebuildIndex(options(home));

    const results = await searchMemories("legacy project", options(home));
    expect(results[0]).toMatchObject({
      id: "2026-01-01-legacy-project",
      type: "project",
      source: "agent",
      scope: "brain",
      confidence: "medium"
    });
    expect(isStoredMemoryType("project")).toBe(true);
    expect(isMemoryType("project")).toBe(false);
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
    expect(result.promotionCandidatesPath).toBeTruthy();
    await expect(readFile(result.promotionCandidatesPath!, "utf8")).resolves.toContain("No promotion candidates.");
    await expect(readFile(oldEpisode, "utf8")).rejects.toThrow();
    expect((await searchMemories("inventing facts", options(home)))[0]?.id).toBe(added.id);
  });

  test("dream writes promotion candidates without creating durable memories", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    const episode = await addMemory(
      {
        type: "episode",
        text: "Session found that staging deploy review comments need handling before merge.",
        metadata: { promoteAs: "workflow" }
      },
      options(home)
    );

    const result = await dreamRun(options(home));

    expect(result.promotionCandidatesPath).toBeTruthy();
    const candidates = await readFile(result.promotionCandidatesPath!, "utf8");
    expect(candidates).toContain(episode.id);
    expect(candidates).toContain("suggestedType: workflow");
    expect(candidates).toContain(`openbrain memory promote ${episode.id} --type workflow --text "<final durable memory>"`);
    expect(await searchMemories("staging deploy review", { ...options(home), durableOnly: true })).toHaveLength(0);
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
    expect(dreamFiles.filter((file) => file.endsWith("-dream.md"))).toHaveLength(2);
    expect(dreamFiles.filter((file) => file.includes("promotion-candidates"))).toHaveLength(2);
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

describe("Claude adapter sync", () => {
  test("writes the OpenBrain block into global Claude instructions", async () => {
    const home = await tempHome();
    const claudeHome = path.join(home, ".claude");
    await initOpenBrain(options(home));

    await syncClaudeAgent({ ...options(home), claudeHome });
    const agentFile = await readFile(path.join(claudeHome, "CLAUDE.md"), "utf8");

    expect(agentFile).toContain("OpenBrain uses the current workspace path only to choose the active brain.");
    expect(agentFile).toContain("openbrain dream maybe --quiet");
    expect(agentFile).toContain("openbrain memory search");
    expect(agentFile.indexOf("openbrain dream maybe --quiet")).toBeLessThan(
      agentFile.indexOf("openbrain memory search")
    );
  });

  test("updates only the marked OpenBrain block", async () => {
    const home = await tempHome();
    const claudeHome = path.join(home, ".claude");
    await initOpenBrain(options(home));

    await syncClaudeAgent({ ...options(home), claudeHome });
    const first = await readFile(path.join(claudeHome, "CLAUDE.md"), "utf8");
    await writeFile(
      path.join(claudeHome, "CLAUDE.md"),
      `# Existing rules\n\nDo not remove this.\n\n${first}`,
      "utf8"
    );

    await syncClaudeAgent({ ...options(home), claudeHome });
    const second = await readFile(path.join(claudeHome, "CLAUDE.md"), "utf8");

    expect(second).toContain("Do not remove this.");
    expect(second.match(/BEGIN OPENBRAIN/g)).toHaveLength(1);
  });

  test("installs a SessionStart hook in settings.json", async () => {
    const home = await tempHome();
    const claudeHome = path.join(home, ".claude");
    await initOpenBrain(options(home));

    await syncClaudeAgent({ ...options(home), claudeHome });
    const settings = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));

    const commands = settings.hooks.SessionStart.flatMap(
      (group: { hooks: { command: string }[] }) => group.hooks.map((h) => h.command)
    );
    expect(commands).toContain("openbrain hook session-start");
  });

  test("preserves existing settings and hooks when installing the hook", async () => {
    const home = await tempHome();
    const claudeHome = path.join(home, ".claude");
    await initOpenBrain(options(home));
    await mkdir(claudeHome, { recursive: true });
    await writeFile(
      path.join(claudeHome, "settings.json"),
      JSON.stringify(
        {
          model: "opus",
          hooks: {
            SessionStart: [{ hooks: [{ type: "command", command: "echo keep-me" }] }],
            Stop: [{ hooks: [{ type: "command", command: "echo other-hook" }] }]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    await syncClaudeSettings({ ...options(home), claudeHome });
    const settings = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));

    expect(settings.model).toBe("opus");
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo other-hook");
    const commands = settings.hooks.SessionStart.flatMap(
      (group: { hooks: { command: string }[] }) => group.hooks.map((h) => h.command)
    );
    expect(commands).toContain("echo keep-me");
    expect(commands).toContain("openbrain hook session-start");
  });

  test("re-syncing does not duplicate the SessionStart hook", async () => {
    const home = await tempHome();
    const claudeHome = path.join(home, ".claude");
    await initOpenBrain(options(home));

    await syncClaudeSettings({ ...options(home), claudeHome });
    await syncClaudeSettings({ ...options(home), claudeHome });
    const settings = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));

    const commands = settings.hooks.SessionStart.flatMap(
      (group: { hooks: { command: string }[] }) => group.hooks.map((h) => h.command)
    );
    expect(commands.filter((c: string) => c === "openbrain hook session-start")).toHaveLength(1);
  });

  test("session-start hook runs dreaming and returns a search reminder", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));

    const reminder = await runSessionStartHook(options(home));

    expect(reminder).toContain("openbrain memory search");
    expect(reminder).toContain("openbrain memory add");
  });

  test("session-start hook does not claim memory is active for an unassigned path", async () => {
    const home = await tempHome();
    const projectPath = path.join(home, "new-project");
    await initOpenBrain(options(home));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ brains: { default: "main", unmatched: "ask", pathRules: [] } }, null, 2),
      "utf8"
    );

    const reminder = await runSessionStartHook({ ...options(home), cwd: projectPath });

    expect(reminder).toContain("openbrain brain add-path");
    expect(reminder).toContain(projectPath);
    expect(reminder).not.toContain("memory is active");
    expect(reminder).not.toContain("Daily dreaming has already been handled");
  });

  test("session-start hook reports OpenBrain disabled for a disabled path", async () => {
    const home = await tempHome();
    const projectPath = path.join(home, "off-project");
    await initOpenBrain(options(home));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ brains: { default: "main", unmatched: "disabled", pathRules: [] } }, null, 2),
      "utf8"
    );

    const reminder = await runSessionStartHook({ ...options(home), cwd: projectPath });

    expect(reminder).toContain("disabled for this workspace path");
    expect(reminder).not.toContain("memory is active");
  });
});
