import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { canonicalPathForRule } from "../src/brains.js";
import { loadConfig } from "../src/config.js";
import {
  isSqliteNodeAbiMismatch,
  openDatabase,
  openSqliteDatabase,
  sqliteNativeModuleRecoveryMessage
} from "../src/db.js";
import {
  addBrainPath,
  addMemory,
  deleteMemory,
  dreamMaybe,
  dreamRun,
  getBrainStatus,
  getCurrentBrain,
  initOpenBrain,
  listMemories,
  listPendingReviews,
  markReviewDone,
  mergeMemory,
  promoteMemory,
  pruneEpisodes,
  rebuildIndex,
  runSessionStartHook,
  searchMemories,
  setupOpenBrain,
  showMemory,
  syncClaudeAgent,
  syncClaudeSettings,
  syncCodexAgent,
  updateMemory
} from "../src/openbrain.js";
import type { EmbeddingProvider, OpenBrainOptions } from "../src/types.js";
import { isMemoryType, isStoredMemoryType } from "../src/types.js";

const execFileAsync = promisify(execFile);
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

async function setTreePermissions(root: string, dirMode: number, fileMode: number) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await setTreePermissions(entryPath, dirMode, fileMode);
    } else {
      await chmod(entryPath, fileMode);
    }
  }
  await chmod(root, dirMode);
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

  test("explains how to recover from a better-sqlite3 Node ABI mismatch", async () => {
    expect(
      isSqliteNodeAbiMismatch(
        new Error(
          "better_sqlite3.node was compiled against a different Node.js version using NODE_MODULE_VERSION 137"
        )
      )
    ).toBe(true);
    const sourceRoot = await tempHome();
    await mkdir(path.join(sourceRoot, ".git"));
    const sourceMessage = sqliteNativeModuleRecoveryMessage(sourceRoot);
    expect(sourceMessage).toContain(`cd '${sourceRoot}' && pnpm rebuild better-sqlite3`);
    expect(sourceMessage).not.toContain("Or reinstall OpenBrain");

    const installerRoot = await tempHome();
    await mkdir(path.join(installerRoot, "scripts"));
    await writeFile(path.join(installerRoot, "scripts", "install.sh"), "");
    const installerMessage = sqliteNativeModuleRecoveryMessage(installerRoot);
    expect(installerMessage).toContain(`cd '${installerRoot}' && pnpm rebuild better-sqlite3`);
    expect(installerMessage).toContain(`install.sh | OPENBRAIN_INSTALL_DIR='${installerRoot}' bash`);

    const npmRoot = await mkdtemp(path.join(tmpdir(), "openbrain-npm-"));
    try {
      const npmMessage = sqliteNativeModuleRecoveryMessage(npmRoot);
      expect(npmMessage).toContain(`cd '${npmRoot}' && npm rebuild better-sqlite3`);
      expect(npmMessage).toContain("npm install -g @nicholls73/openbrain --force");
    } finally {
      await rm(npmRoot, { recursive: true, force: true });
    }

    expect(sqliteNativeModuleRecoveryMessage('/tmp/$HOME/$(oops)/`tick`/"double"/it\'s')).toContain(
      "cd '/tmp/$HOME/$(oops)/`tick`/\"double\"/it'\\''s' && npm rebuild better-sqlite3"
    );
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

    await expect(readFile(path.join(home, "config.json"), "utf8")).resolves.toContain('"retentionDays": 30');
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

  test("opens the database read-only when asked, rejecting writes", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));

    const db = await openDatabase({ home, brain: "main" }, { readonly: true });
    try {
      expect(db.readonly).toBe(true);
      expect(() => db.exec("DELETE FROM memories")).toThrow(/readonly/i);
    } finally {
      db.close();
    }
  });

  test("search, list, and show work when the memory store is not writable", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    const added = await addMemory(
      { type: "workflow", text: "Read-only sandbox agents can still search memory." },
      options(home)
    );

    await setTreePermissions(home, 0o555, 0o444);
    try {
      const results = await searchMemories("read-only sandbox", options(home));
      expect(results[0]).toMatchObject({ id: added.id });
      expect((await listMemories(options(home))).map((memory) => memory.id)).toContain(added.id);
      await expect(showMemory(added.id, options(home))).resolves.toContain("sandbox agents");
    } finally {
      await setTreePermissions(home, 0o755, 0o644);
    }
  });

  test("a read-only search still creates a missing database when the store is writable", async () => {
    const home = await tempHome();

    await expect(searchMemories("anything", options(home))).resolves.toEqual([]);

    await expect(stat(path.join(home, "brains", "main", "openbrain.db"))).resolves.toBeDefined();
  });

  test("expands ~ and ~/ to the home directory but leaves ~user paths alone", () => {
    expect(canonicalPathForRule("~")).toBe(canonicalPathForRule(homedir()));
    expect(canonicalPathForRule("~/no-such-openbrain-dir")).toBe(
      path.join(homedir(), "no-such-openbrain-dir")
    );
    expect(canonicalPathForRule("~foo/x")).toBe(path.resolve("~foo/x"));
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

  test("git worktrees inherit the brain of their source repo", async () => {
    const home = await tempHome();
    const repo = path.join(home, "projects", "alpha-repo");
    const worktree = path.join(home, "worktrees", "alpha-feature");
    await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, "README.md"), "alpha\n", "utf8");
    const git = (args: string[]) =>
      execFileAsync("git", ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@test", ...args]);
    await git(["init"]);
    await git(["add", "."]);
    await git(["commit", "-m", "init"]);
    await git(["worktree", "add", worktree, "-b", "feature"]);

    await initOpenBrain(options(home));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify(
        {
          brains: {
            default: "main",
            unmatched: "ask",
            pathRules: [{ brain: "alpha", paths: [repo] }]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    // The source repo matches its rule directly; the linked worktree inherits
    // the same brain even though no rule names its path.
    expect(await getBrainStatus({ ...options(home), cwd: repo })).toEqual({
      brain: "alpha",
      state: "active"
    });
    expect(await getBrainStatus({ ...options(home), cwd: worktree })).toEqual({
      brain: "alpha",
      state: "active"
    });

    // Paths that are not worktrees of a mapped repo keep the ask behaviour.
    expect(await getBrainStatus({ ...options(home), cwd: path.join(home, "elsewhere") })).toEqual({
      brain: "main",
      state: "ask"
    });

    // An explicit rule for the worktree path takes precedence over inheritance.
    await addBrainPath("beta", worktree, options(home));
    expect(await getBrainStatus({ ...options(home), cwd: worktree })).toEqual({
      brain: "beta",
      state: "active"
    });
  });

  test("getBrainStatus reports a typed state instead of a delimited string", async () => {
    const home = await tempHome();
    const projectPath = path.join(home, "new-project");
    await initOpenBrain(options(home));

    expect(await getBrainStatus(options(home))).toEqual({ brain: "main", state: "active" });

    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ brains: { default: "main", unmatched: "ask", pathRules: [] } }, null, 2),
      "utf8"
    );
    expect(await getBrainStatus({ ...options(home), cwd: projectPath })).toEqual({
      brain: "main",
      state: "ask"
    });

    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ brains: { default: "main", unmatched: "disabled", pathRules: [] } }, null, 2),
      "utf8"
    );
    expect(await getBrainStatus({ ...options(home), cwd: projectPath })).toEqual({
      brain: "main",
      state: "disabled"
    });
  });

  test("concurrent path rule additions do not lose config writes", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));

    await Promise.all([
      addBrainPath("alpha", path.join(home, "projects", "alpha"), options(home)),
      addBrainPath("beta", path.join(home, "projects", "beta"), options(home)),
      addBrainPath("gamma", path.join(home, "projects", "gamma"), options(home))
    ]);

    const config = await loadConfig(options(home));
    expect(config.brains.pathRules.map((rule) => rule.brain).sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("takes over a stale config lock left by a crashed process", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    const lockPath = path.join(home, "config.json.lock");
    await mkdir(lockPath, { recursive: true });
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    await addBrainPath("alpha", path.join(home, "projects", "alpha"), options(home));

    const config = await loadConfig(options(home));
    expect(config.brains.pathRules.map((rule) => rule.brain)).toEqual(["alpha"]);
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
    expect(config.retrieval).toEqual({ limit: 5, minVectorSimilarity: 0.25 });
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
    await expect(readFile(path.join(codexHome, "AGENTS.md"), "utf8")).resolves.toContain("BEGIN OPENBRAIN");
    await expect(readFile(path.join(claudeHome, "CLAUDE.md"), "utf8")).resolves.toContain("BEGIN OPENBRAIN");
  });

  test("setup auto-detects agents from their config directories when no flags are given", async () => {
    const home = await tempHome();
    const codexHome = path.join(home, ".codex");
    const claudeHome = path.join(home, ".claude");
    await mkdir(codexHome, { recursive: true });

    const result = await setupOpenBrain(
      { brainScope: "default" },
      { ...options(home), codexHome, claudeHome }
    );
    const config = await loadConfig(options(home));

    expect(result).toMatchObject({
      codexDetected: true,
      claudeDetected: false,
      codexAgentFile: path.join(codexHome, "AGENTS.md"),
      claudeAgentFile: undefined,
      claudeSettingsFile: undefined
    });
    expect(config.agents.codex.enabled).toBe(true);
    expect(config.agents.claude.enabled).toBe(false);
    await expect(readFile(path.join(codexHome, "AGENTS.md"), "utf8")).resolves.toContain("BEGIN OPENBRAIN");
    await expect(stat(path.join(claudeHome, "CLAUDE.md"))).rejects.toThrow();
  });

  test("setup flags override agent detection in both directions", async () => {
    const home = await tempHome();
    const codexHome = path.join(home, ".codex");
    const claudeHome = path.join(home, ".claude");
    await mkdir(codexHome, { recursive: true });

    const result = await setupOpenBrain(
      {
        brainScope: "default",
        syncCodex: false,
        syncClaude: true
      },
      { ...options(home), codexHome, claudeHome }
    );
    const config = await loadConfig(options(home));

    expect(result).toMatchObject({
      codexDetected: true,
      claudeDetected: false,
      codexAgentFile: undefined,
      claudeAgentFile: path.join(claudeHome, "CLAUDE.md")
    });
    expect(config.agents.codex.enabled).toBe(false);
    expect(config.agents.claude.enabled).toBe(true);
    await expect(stat(path.join(codexHome, "AGENTS.md"))).rejects.toThrow();
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
        syncCodex: false,
        syncClaude: false
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

  test("rebuildIndex keeps the existing index when a memory file fails to parse", async () => {
    const home = await tempHome();
    await addMemory({ type: "workflow", text: "Deploy with the release checklist." }, options(home));

    const invalid = path.join(home, "brains", "main", "memories", "2026-06-04-broken.md");
    await writeFile(
      invalid,
      ["---", "id: 2026-06-04-broken", "title: Missing type", "---", "", "Broken frontmatter.", ""].join(
        "\n"
      ),
      "utf8"
    );

    await expect(rebuildIndex(options(home))).rejects.toThrow(/missing (type|createdAt)/);

    const results = await searchMemories("release checklist", options(home));
    expect(results).toHaveLength(1);
    expect(results[0]?.title).toBe("Deploy with the release checklist");
  });

  test("excerpt anchors on the numerically earliest query match", async () => {
    const home = await tempHome();
    // "alpha" matches at index 9 and "zulu" past index 100. A lexicographic
    // sort of the match indexes puts "101" before "9" and anchored the
    // excerpt on the later match, cutting off the start of the memory.
    const body = `12345678 alpha ${"p".repeat(85)} zulu end`;
    await addMemory({ type: "workflow", text: body }, options(home));

    const results = await searchMemories("alpha zulu", options(home));
    expect(results).toHaveLength(1);
    expect(results[0]?.excerpt.startsWith("12345678 alpha")).toBe(true);
  });

  test("warns when query embedding fails so FTS-only degradation is visible", async () => {
    const home = await tempHome();
    await addMemory({ type: "workflow", text: "Deploy with the release checklist." }, options(home));
    const failingEmbedder: EmbeddingProvider = {
      async embed() {
        throw new Error("model unavailable");
      }
    };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const results = await searchMemories("release checklist", options(home, failingEmbedder));
      expect(results).toHaveLength(1);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("FTS-only");
    } finally {
      warn.mockRestore();
    }
  });

  test("memory update rewrites the body in place and records updatedAt", async () => {
    const home = await tempHome();
    const original = await addMemory(
      { type: "workflow", text: "Deploy with the release checklist." },
      options(home)
    );

    const later = { ...options(home), now: () => new Date("2026-06-05T10:00:00.000Z") };
    const updated = await updateMemory(
      { id: original.id, text: "Deploy with the release checklist and the smoke-test step." },
      later
    );

    expect(updated.id).toBe(original.id);
    expect(updated.path).toBe(original.path);
    expect(updated.createdAt).toBe(original.createdAt);
    expect(updated.metadata.updatedAt).toBe("2026-06-05T10:00:00.000Z");

    const raw = await readFile(original.path, "utf8");
    expect(raw).toContain("smoke-test step");
    expect(raw).toContain("updatedAt: 2026-06-05T10:00:00.000Z");

    const results = await searchMemories("smoke-test", options(home));
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(original.id);
    expect(await listMemories(options(home))).toHaveLength(1);
  });

  test("memory update rejects unknown ids", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));

    await expect(updateMemory({ id: "missing", text: "nope" }, options(home))).rejects.toThrow(
      "Memory not found: missing"
    );
  });

  test("adding a near-duplicate durable memory reports the existing one", async () => {
    const home = await tempHome();
    const embedder: EmbeddingProvider = {
      async embed() {
        return [1, 0, 0];
      }
    };
    const first = await addMemory(
      { type: "workflow", text: "Always run the release checklist before deploying." },
      options(home, embedder)
    );

    const second = await addMemory(
      { type: "workflow", text: "Run the release checklist prior to every deploy." },
      options(home, embedder)
    );

    expect(second.duplicateOf?.id).toBe(first.id);
    expect(second.duplicateOf?.similarity).toBeCloseTo(1, 5);
    // Write + notice: the new memory still lands on disk.
    await expect(readFile(second.path, "utf8")).resolves.toContain("prior to every deploy");

    // A different durable type is not treated as a duplicate.
    const decision = await addMemory(
      { type: "decision", text: "We deploy on Tuesdays." },
      options(home, embedder)
    );
    expect(decision.duplicateOf).toBeUndefined();

    // Episodes are exempt: repeated session notes are expected.
    const episode = await addMemory(
      { type: "episode", text: "Ran the release checklist again today." },
      options(home, embedder)
    );
    expect(episode.duplicateOf).toBeUndefined();
  });

  test("memory merge folds the source into the target and deletes the source", async () => {
    const home = await tempHome();
    const keep = await addMemory({ type: "workflow", text: "Release via the checklist." }, options(home));
    const dup = await addMemory({ type: "workflow", text: "Use the checklist to release." }, options(home));

    const merged = await mergeMemory(
      { sourceId: dup.id, targetId: keep.id, text: "Release via the checklist, including smoke tests." },
      options(home)
    );

    expect(merged.id).toBe(keep.id);
    expect(await listMemories(options(home))).toHaveLength(1);
    await expect(readFile(dup.path, "utf8")).rejects.toThrow();
    const results = await searchMemories("smoke tests", options(home));
    expect(results[0]?.id).toBe(keep.id);

    await expect(
      mergeMemory({ sourceId: keep.id, targetId: keep.id, text: "same id" }, options(home))
    ).rejects.toThrow("two different memory ids");
  });

  test("dream writes a consolidation review of likely duplicate durable memories", async () => {
    const home = await tempHome();
    const embedder: EmbeddingProvider = {
      async embed() {
        return [1, 0, 0];
      }
    };
    const first = await addMemory(
      { type: "workflow", text: "Always run the release checklist before deploying." },
      options(home, embedder)
    );
    const second = await addMemory(
      { type: "workflow", text: "Run the release checklist prior to every deploy." },
      options(home, embedder)
    );

    const result = await dreamRun(options(home, embedder));
    expect(result.status).toBe("ran");
    if (result.status !== "ran") {
      return;
    }
    expect(result.consolidationReportPath).toBeDefined();
    const report = await readFile(result.consolidationReportPath!, "utf8");
    expect(report).toContain(first.id);
    expect(report).toContain(second.id);
    expect(report).toContain(`openbrain memory merge ${second.id} --into ${first.id}`);
    expect(report).toContain("never merges or deletes");
  });

  test("dream writes no consolidation review when memories are distinct", async () => {
    const home = await tempHome();
    await addMemory({ type: "workflow", text: "Release via the checklist." }, options(home));

    const result = await dreamRun(options(home));
    if (result.status !== "ran") {
      throw new Error("expected dream to run");
    }
    expect(result.consolidationReportPath).toBeUndefined();
    expect(await listPendingReviews(options(home))).toHaveLength(0);
  });

  test("dream discovers recurring unmarked episodes as promotion candidates", async () => {
    const home = await tempHome();
    const embedder: EmbeddingProvider = {
      async embed(text) {
        return text.includes("batman") ? [1, 0, 0] : [0, 1, 0];
      }
    };
    const episodes = await Promise.all(
      ["alpha", "beta", "gamma"].map((repository) =>
        addMemory(
          {
            type: "episode",
            text: `Repository ${repository} used batman as its root commit message.`,
            metadata: { confidence: "low" }
          },
          options(home, embedder)
        )
      )
    );

    const result = await dreamRun(options(home, embedder));
    if (result.status !== "ran") {
      throw new Error("expected dream to run");
    }
    expect(result.promotionCandidatesPath).toBeDefined();
    const report = await readFile(result.promotionCandidatesPath!, "utf8");
    expect(report).toContain("Recurring episode pattern");
    expect(report).toContain("- evidenceCount: 3");
    expect(report).toContain("- suggestedType: preference");
    expect(report).toContain("- draft:");
    for (const episode of episodes) {
      expect(report).toContain(episode.id);
    }
  });

  test("dream resists one-off and transient recurring episode false positives", async () => {
    const home = await tempHome();
    const embedder: EmbeddingProvider = {
      async embed(text) {
        return text.includes("temporary branch") ? [0, 1, 0] : [1, 0, 0];
      }
    };
    for (const repository of ["alpha", "beta"]) {
      await addMemory(
        {
          type: "episode",
          text: `Repository ${repository} used batman as its root commit message.`,
          metadata: { confidence: "low" }
        },
        options(home, embedder)
      );
    }
    for (const branch of ["feature/a", "feature/b", "feature/c"]) {
      await addMemory(
        {
          type: "episode",
          text: `The temporary branch ${branch} was touched during this task.`,
          metadata: { confidence: "low" }
        },
        options(home, embedder)
      );
    }

    const result = await dreamRun(options(home, embedder));
    if (result.status !== "ran") {
      throw new Error("expected dream to run");
    }
    expect(result.promotionCandidatesPath).toBeUndefined();
  });

  test("dream preserves explicit candidates alongside recurring discoveries", async () => {
    const home = await tempHome();
    const embedder: EmbeddingProvider = {
      async embed(text) {
        return text.includes("batman") ? [1, 0, 0] : [0, 1, 0];
      }
    };
    const explicit = await addMemory(
      {
        type: "episode",
        text: "The team decided to retain the release approval gate.",
        metadata: { promoteAs: "decision" }
      },
      options(home, embedder)
    );
    for (const repository of ["alpha", "beta", "gamma"]) {
      await addMemory(
        {
          type: "episode",
          text: `Repository ${repository} used batman as its root commit message.`,
          metadata: { confidence: "low" }
        },
        options(home, embedder)
      );
    }

    const result = await dreamRun(options(home, embedder));
    if (result.status !== "ran") {
      throw new Error("expected dream to run");
    }
    const report = await readFile(result.promotionCandidatesPath!, "utf8");
    expect(report).toContain(explicit.id);
    expect(report).toContain("- suggestedType: decision");
    expect(report).toContain("Recurring episode pattern");
  });

  test("dream excludes private explicit promotion candidates", async () => {
    const home = await tempHome();
    await addMemory(
      {
        type: "episode",
        text: "Private evidence must not appear in automatic review files.",
        metadata: { promoteAs: "decision", sensitivity: "private" }
      },
      options(home)
    );

    const result = await dreamRun(options(home));
    if (result.status !== "ran") {
      throw new Error("expected dream to run");
    }
    expect(result.promotionCandidatesPath).toBeUndefined();
  });

  test("dream retains overlapping mutually similar episode groups", async () => {
    const home = await tempHome();
    const vector = (degrees: number) => {
      const radians = (degrees * Math.PI) / 180;
      return [Math.cos(radians), Math.sin(radians)];
    };
    const embedder: EmbeddingProvider = {
      async embed(text) {
        if (text.includes("00 X")) {
          return vector(-20);
        }
        if (text.includes("01 A")) {
          return vector(0);
        }
        if (text.includes("02 B")) {
          return vector(20);
        }
        return vector(22);
      }
    };
    const episodes = [];
    for (const observation of ["00 X", "01 A", "02 B", "03 C"]) {
      episodes.push(
        await addMemory(
          {
            type: "episode",
            text: `${observation} recorded the recurring naming style.`,
            metadata: { confidence: "low" }
          },
          options(home, embedder)
        )
      );
    }

    const result = await dreamRun(options(home, embedder));
    if (result.status !== "ran") {
      throw new Error("expected dream to run");
    }
    const report = await readFile(result.promotionCandidatesPath!, "utf8");
    expect(report).not.toContain(episodes[0]!.id);
    for (const episode of episodes.slice(1)) {
      expect(report).toContain(episode.id);
    }
  });

  test("session start surfaces pending reviews until they are marked done", async () => {
    const home = await tempHome();
    await addMemory(
      {
        type: "episode",
        text: "Staging deploys need review comments handled before merge.",
        metadata: { promoteAs: "workflow" }
      },
      options(home)
    );

    const dream = await dreamRun(options(home));
    if (dream.status !== "ran") {
      throw new Error("expected dream to run");
    }
    expect(dream.promotionCandidatesPath).toBeDefined();

    const pending = await listPendingReviews(options(home));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "promotion-candidates", path: dream.promotionCandidatesPath });

    const reminder = await runSessionStartHook(options(home));
    expect(reminder).toContain("Pending memory reviews (1):");
    expect(reminder).toContain(dream.promotionCandidatesPath!);
    expect(reminder).toContain("openbrain review done");

    const actioned = await markReviewDone(dream.promotionCandidatesPath!, options(home));
    expect(actioned).toContain(path.join("dreams", "actioned"));
    await expect(readFile(actioned, "utf8")).resolves.toContain("Promotion candidates");

    expect(await listPendingReviews(options(home))).toHaveLength(0);
    expect(await runSessionStartHook(options(home))).not.toContain("Pending memory reviews");
  });

  test("review done rejects unknown and non-review files", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));

    await expect(markReviewDone("2026-06-04-notes.md", options(home))).rejects.toThrow("Not a review file");
    await expect(markReviewDone("2026-06-04-missing-consolidation.md", options(home))).rejects.toThrow(
      "Review file not found"
    );
  });

  test("legacy empty review files are never pending", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    const dreams = path.join(home, "brains", "main", "dreams");
    await mkdir(dreams, { recursive: true });
    await writeFile(
      path.join(dreams, "2026-06-01-legacy-consolidation.md"),
      "# Consolidation review\n\nNo likely duplicates.\n",
      "utf8"
    );

    expect(await listPendingReviews(options(home))).toHaveLength(0);
  });

  test("does not warn about FTS-only results when embeddings are disabled", async () => {
    const home = await tempHome();
    await addMemory({ type: "workflow", text: "Deploy with the release checklist." }, options(home));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await searchMemories("release checklist", options(home));
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("FTS-only");
    } finally {
      warn.mockRestore();
    }
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

      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "ignored invalid confidence"
      );
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "ignored invalid sensitivity"
      );
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "ignored invalid expiresAt"
      );
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "ignored invalid promoteAs"
      );
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

  test("returns no result when only weak vector candidates exist", async () => {
    const home = await tempHome();
    const query = "purple wombat trampoline xylophone";
    const embedder: EmbeddingProvider = {
      async embed(text: string) {
        return text === query ? [0.2, Math.sqrt(0.96)] : [1, 0];
      }
    };
    await initOpenBrain(options(home, embedder));
    await addMemory(
      { type: "workflow", text: "Deploy production after the release checklist passes." },
      options(home, embedder)
    );

    expect(await searchMemories(query, options(home, embedder))).toEqual([]);
  });

  test("retains vector candidates whose similarity equals the threshold", async () => {
    const home = await tempHome();
    const query = "purple wombat trampoline xylophone";
    // cosine([1 x16], one-hot) = 1 / sqrt(16) = exactly 0.25, the default floor.
    const embedder: EmbeddingProvider = {
      async embed(text: string) {
        return text === query
          ? Array.from({ length: 16 }, () => 1)
          : [1, ...Array.from({ length: 15 }, () => 0)];
      }
    };
    await initOpenBrain(options(home, embedder));
    await addMemory(
      { type: "workflow", text: "Deploy production after the release checklist passes." },
      options(home, embedder)
    );

    const results = await searchMemories(query, options(home, embedder));

    expect(results).toHaveLength(1);
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

  test("reads legacy JSON embeddings and rewrites them as float32 blobs on rebuild", async () => {
    const embedder: EmbeddingProvider = {
      async embed() {
        return [1, 0, 0];
      }
    };
    const home = await tempHome();
    await addMemory({ type: "workflow", text: "Vector memory about deployment." }, options(home, embedder));

    // Simulate a database written before the float32 blob encoding.
    const legacyDb = await openDatabase({ home, brain: "main" });
    try {
      legacyDb.prepare("UPDATE memories SET embedding = ?").run(JSON.stringify([1, 0, 0]));
    } finally {
      legacyDb.close();
    }

    const results = await searchMemories("deployment", options(home, embedder));
    expect(results).toHaveLength(1);
    expect(results[0]?.match).toBe("hybrid");

    await rebuildIndex(options(home, embedder));
    const db = await openDatabase({ home, brain: "main" });
    try {
      const row = db.prepare("SELECT embedding FROM memories").get() as { embedding: unknown };
      expect(Buffer.isBuffer(row.embedding)).toBe(true);
    } finally {
      db.close();
    }
    expect((await searchMemories("deployment", options(home, embedder)))[0]?.match).toBe("hybrid");
  });

  test("rebuild reuses stored embeddings and re-embeds only changed memories", async () => {
    const home = await tempHome();
    let embedCalls = 0;
    const embedder: EmbeddingProvider = {
      async embed() {
        embedCalls += 1;
        return [1, 0, 0];
      }
    };
    await initOpenBrain(options(home, embedder));
    const first = await addMemory(
      { type: "workflow", text: "first durable memory" },
      options(home, embedder)
    );
    await addMemory({ type: "decision", text: "second durable memory" }, options(home, embedder));

    // Unchanged memories keep their stored embeddings: the daily dream's
    // rebuild must not re-embed the whole brain at session start.
    embedCalls = 0;
    await rebuildIndex(options(home, embedder));
    expect(embedCalls).toBe(0);

    // Editing a body invalidates only that memory's stored embedding.
    const raw = await readFile(first.path, "utf8");
    await writeFile(first.path, `${raw}Edited detail.\n`, "utf8");
    embedCalls = 0;
    await rebuildIndex(options(home, embedder));
    expect(embedCalls).toBe(1);

    const results = await searchMemories("edited detail", options(home, embedder));
    expect(results[0]?.id).toBe(first.id);
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

  test("prune keeps episodes whose explicit expiresAt is still in the future", async () => {
    const home = await tempHome();
    const episode = await addMemory(
      {
        type: "episode",
        text: "Extended handoff context stays until December.",
        metadata: { expiresAt: "2026-12-01T00:00:00.000Z" }
      },
      options(home)
    );

    // Two months later: past the 30-day retention cutoff, before expiresAt.
    const later = { ...options(home), now: () => new Date("2026-08-01T00:00:00.000Z") };
    const pruned = await pruneEpisodes(later);

    expect(pruned).toHaveLength(0);
    await expect(readFile(episode.path, "utf8")).resolves.toContain("Extended handoff context");
    expect(await searchMemories("extended handoff", later)).toHaveLength(1);
  });

  test("prune removes episodes at their explicit expiresAt before the retention cutoff", async () => {
    const home = await tempHome();
    const episode = await addMemory(
      {
        type: "episode",
        text: "Short-lived note expires tomorrow.",
        metadata: { expiresAt: "2026-06-05T00:00:00.000Z" }
      },
      options(home)
    );

    // Six days later: well within 30-day retention, past expiresAt.
    const later = { ...options(home), now: () => new Date("2026-06-10T00:00:00.000Z") };
    const pruned = await pruneEpisodes(later);

    expect(pruned).toContain(episode.path);
    await expect(readFile(episode.path, "utf8")).rejects.toThrow();
    expect(await listMemories(options(home))).toHaveLength(0);
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
    await expect(
      readFile(path.join(home, "brains", "main", "dreams", "state.json"), "utf8")
    ).resolves.toContain('"lastDreamDate": "2026-06-04"');
    await expect(readFile(result.logPath, "utf8")).resolves.toContain("Dream run");
    // Nothing to action means no review file is written at all.
    expect(result.promotionCandidatesPath).toBeUndefined();
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
    expect(candidates).toContain(
      `openbrain memory promote ${episode.id} --type workflow --text "<final durable memory>"`
    );
    expect(
      await searchMemories("staging deploy review", { ...options(home), durableOnly: true })
    ).toHaveLength(0);
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
    // No promotion candidates existed, so no review files were written.
    expect(dreamFiles.filter((file) => file.includes("promotion-candidates"))).toHaveLength(0);
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
    expect(agentFile).toContain(
      "active brain. Refer to paths only when configuring brain routing or discussing"
    );
    expect(agentFile).toContain('openbrain brain add-path <brain> "<current workspace path>"');
    expect(agentFile).toContain('openbrain memory add --type workspace --text "..."');
    expect(agentFile).toContain('openbrain memory add --type episode --confidence low --text "..."');
    expect(agentFile).toContain("evidence rather than an already-established durable conclusion");
    expect(agentFile).toContain("Record durable memories only when the guidance is likely to stay useful");
    expect(agentFile).toContain("Do not store branch names, PR");
    expect(agentFile).toContain("If short-lived handoff context is useful, store it as");
    expect(agentFile).toContain("For POC or reference work, classify details before storing them.");
    expect(agentFile).toContain("approve elevated filesystem access, then rerun the exact same command");
    expect(agentFile).toContain("- `workspace`: stable workspace, toolchain, or recurring task conventions.");
    expect(agentFile).toContain(
      "- `episode`: short-lived session notes, handoff state, or fast-changing facts."
    );
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
    expect(first.indexOf("openbrain dream maybe --quiet")).toBeLessThan(
      first.indexOf("openbrain memory search")
    );

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

    const commands = settings.hooks.SessionStart.flatMap((group: { hooks: { command: string }[] }) =>
      group.hooks.map((h) => h.command)
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
    const commands = settings.hooks.SessionStart.flatMap((group: { hooks: { command: string }[] }) =>
      group.hooks.map((h) => h.command)
    );
    expect(commands).toContain("echo keep-me");
    expect(commands).toContain("openbrain hook session-start");
  });

  test.each([
    ["a non-object top-level value", JSON.stringify([1, 2, 3]), "the top-level value is not an object"],
    ["a non-object hooks value", JSON.stringify({ hooks: [] }), '"hooks" is not an object'],
    [
      "a non-array SessionStart value",
      JSON.stringify({ hooks: { SessionStart: { hooks: [] } } }, null, 2),
      '"hooks.SessionStart" is not an array'
    ]
  ])("refuses to overwrite %s instead of discarding it", async (_label, malformed, message) => {
    const home = await tempHome();
    const claudeHome = path.join(home, ".claude");
    await initOpenBrain(options(home));
    await mkdir(claudeHome, { recursive: true });
    const settingsFile = path.join(claudeHome, "settings.json");
    await writeFile(settingsFile, malformed, "utf8");

    await expect(syncClaudeSettings({ ...options(home), claudeHome })).rejects.toThrow(message);
    expect(await readFile(settingsFile, "utf8")).toBe(malformed);
  });

  test("disables Claude auto-memory only with explicit consent", async () => {
    const home = await tempHome();
    const claudeHome = path.join(home, ".claude");
    await initOpenBrain(options(home));

    await syncClaudeSettings({ ...options(home), claudeHome });
    let settings = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    expect(settings.autoMemoryEnabled).toBeUndefined();

    await syncClaudeSettings({ ...options(home), claudeHome }, true);
    settings = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));
    expect(settings.autoMemoryEnabled).toBe(false);
  });

  test("re-syncing does not duplicate the SessionStart hook", async () => {
    const home = await tempHome();
    const claudeHome = path.join(home, ".claude");
    await initOpenBrain(options(home));

    await syncClaudeSettings({ ...options(home), claudeHome });
    await syncClaudeSettings({ ...options(home), claudeHome });
    const settings = JSON.parse(await readFile(path.join(claudeHome, "settings.json"), "utf8"));

    const commands = settings.hooks.SessionStart.flatMap((group: { hooks: { command: string }[] }) =>
      group.hooks.map((h) => h.command)
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
