import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import {
  addMemory,
  getBrainStatus,
  getBrainStorage,
  searchMemories,
  setBrainStorage
} from "../src/openbrain.js";
import type { EmbeddingProvider, OpenBrainOptions } from "../src/types.js";

const roots: string[] = [];
const noEmbeddings: EmbeddingProvider = {
  disabled: true,
  async embed() {
    return null;
  }
};

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "openbrain-storage-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("per-brain storage", () => {
  test("legacy configuration keeps brains in local storage", async () => {
    const home = await tempRoot();
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ brains: { default: "main", unmatched: "default", pathRules: [] } }),
      "utf8"
    );

    const result = await getBrainStorage("main", { home });

    expect(result.storage).toEqual({ type: "local" });
    expect(result.path).toBe(path.join(home, "brains", "main"));
  });

  test("moves a complete brain to an Obsidian vault and back", async () => {
    const home = await tempRoot();
    const vault = path.join(await tempRoot(), "Vault With Spaces");
    await mkdir(path.join(vault, ".obsidian"), { recursive: true });
    const options: OpenBrainOptions = { home, brain: "main", embedder: noEmbeddings };
    const memory = await addMemory(
      { type: "decision", text: "Store the complete brain inside Obsidian." },
      options
    );
    const source = path.join(home, "brains", "main");
    await writeFile(path.join(source, "dreams", "attachment.txt"), "kept", "utf8");
    await writeFile(path.join(source, "memories", ".lock"), "user data", "utf8");

    const moved = await setBrainStorage("main", { type: "obsidian", vaultPath: vault }, options);

    expect(moved.path).toBe(path.join(await realpath(vault), "OpenBrain", "brains", "main"));
    await expect(stat(source)).rejects.toThrow();
    await expect(readFile(path.join(moved.path, "dreams", "attachment.txt"), "utf8")).resolves.toBe("kept");
    await expect(readFile(path.join(moved.path, "memories", ".lock"), "utf8")).resolves.toBe("user data");
    expect((await searchMemories("complete brain", options))[0]?.id).toBe(memory.id);
    const db = await openDatabase({ ...options, brainRoot: moved.path }, { readonly: true });
    try {
      const row = db.prepare("SELECT path FROM memories WHERE id = ?").get(memory.id) as { path: string };
      expect(row.path.startsWith(moved.path)).toBe(true);
    } finally {
      db.close();
    }
    expect((await loadConfig({ home })).brains.storage.main).toEqual({
      type: "obsidian",
      vaultPath: await realpath(vault)
    });

    const local = await setBrainStorage("main", { type: "local" }, options);
    expect(local.path).toBe(source);
    await expect(stat(moved.path)).rejects.toThrow();
    expect((await searchMemories("complete brain", options))[0]?.id).toBe(memory.id);
  });

  test("moves a brain to the Obsidian vault root without disturbing vault files", async () => {
    const home = await tempRoot();
    const vault = await tempRoot();
    const options: OpenBrainOptions = { home, brain: "main", embedder: noEmbeddings };
    await mkdir(path.join(vault, ".obsidian"));
    await writeFile(path.join(vault, ".obsidian", "app.json"), "{}", "utf8");
    await writeFile(path.join(vault, "Personal.md"), "Keep this note.", "utf8");
    await writeFile(path.join(vault, "openbrain.db"), "Unrelated vault file.", "utf8");
    const memory = await addMemory(
      { type: "decision", text: "Store this brain at the vault root." },
      options
    );

    const moved = await setBrainStorage(
      "main",
      { type: "obsidian", vaultPath: vault, sync: "headless", layout: "root" },
      options
    );

    expect(moved.path).toBe(await realpath(vault));
    expect((await loadConfig({ home })).brains.storage.main).toEqual({
      type: "obsidian",
      vaultPath: await realpath(vault),
      sync: "headless",
      layout: "root"
    });
    await expect(readFile(path.join(vault, ".obsidian", "app.json"), "utf8")).resolves.toBe("{}");
    await expect(readFile(path.join(vault, "Personal.md"), "utf8")).resolves.toBe("Keep this note.");
    await expect(stat(path.join(vault, "memories"))).resolves.toBeDefined();
    await expect(stat(path.join(vault, "OpenBrain"))).rejects.toThrow();
    await expect(readFile(path.join(vault, "openbrain.db"), "utf8")).resolves.toBe("Unrelated vault file.");
    await expect(stat(path.join(home, "indexes", "main", "openbrain.db"))).resolves.toBeDefined();
    expect((await searchMemories("vault root", options))[0]?.id).toBe(memory.id);
  });

  test("flattens an existing nested Obsidian brain into the vault root", async () => {
    const home = await tempRoot();
    const vault = await tempRoot();
    const options: OpenBrainOptions = { home, brain: "main", embedder: noEmbeddings };
    await mkdir(path.join(vault, ".obsidian"));
    await writeFile(path.join(vault, "keep.txt"), "vault file", "utf8");
    const memory = await addMemory({ type: "decision", text: "Move existing vault data safely." }, options);
    const nested = await setBrainStorage("main", { type: "obsidian", vaultPath: vault }, options);
    await writeFile(path.join(nested.path, "dreams", "attachment.txt"), "keep attachment", "utf8");

    const root = await setBrainStorage(
      "main",
      { type: "obsidian", vaultPath: vault, layout: "root" },
      options
    );

    expect(root.path).toBe(await realpath(vault));
    await expect(stat(path.join(vault, "memories"))).resolves.toBeDefined();
    await expect(readFile(path.join(vault, "dreams", "attachment.txt"), "utf8")).resolves.toBe(
      "keep attachment"
    );
    await expect(readFile(path.join(vault, "keep.txt"), "utf8")).resolves.toBe("vault file");
    await expect(stat(nested.path)).rejects.toThrow();
    await expect(stat(path.join(vault, "OpenBrain"))).rejects.toThrow();
    await expect(stat(path.join(home, "indexes", "main", "openbrain.db"))).resolves.toBeDefined();
    expect((await searchMemories("existing vault", options))[0]?.id).toBe(memory.id);
  });

  test("moves a vault-root brain back to local without deleting vault content", async () => {
    const home = await tempRoot();
    const vault = await tempRoot();
    const options: OpenBrainOptions = { home, brain: "main", embedder: noEmbeddings };
    await mkdir(path.join(vault, ".obsidian"));
    await writeFile(path.join(vault, "Personal.md"), "Keep me.", "utf8");
    await addMemory({ type: "decision", text: "Move back safely." }, options);
    await setBrainStorage("main", { type: "obsidian", vaultPath: vault, layout: "root" }, options);

    await setBrainStorage("main", { type: "local" }, options);

    await expect(readFile(path.join(vault, "Personal.md"), "utf8")).resolves.toBe("Keep me.");
    await expect(stat(path.join(vault, ".obsidian"))).resolves.toBeDefined();
    await expect(stat(path.join(vault, "memories"))).rejects.toThrow();
    await expect(stat(path.join(home, "brains", "main", "memories"))).resolves.toBeDefined();
    await expect(stat(path.join(home, "brains", "main", "openbrain.db"))).resolves.toBeDefined();
    expect(await searchMemories("move back", options)).toHaveLength(1);
  });

  test("rejects conflicting top-level brain folders without changing the source", async () => {
    const home = await tempRoot();
    const vault = await tempRoot();
    const options: OpenBrainOptions = { home, brain: "main", embedder: noEmbeddings };
    await mkdir(path.join(vault, ".obsidian"));
    await mkdir(path.join(vault, "memories"));
    await writeFile(path.join(vault, "memories", "Personal.md"), "Do not overwrite.", "utf8");
    const memory = await addMemory({ type: "decision", text: "Keep local source." }, options);

    await expect(
      setBrainStorage("main", { type: "obsidian", vaultPath: vault, layout: "root" }, options)
    ).rejects.toThrow("different memories data");

    expect((await getBrainStorage("main", { home })).storage).toEqual({ type: "local" });
    expect((await searchMemories("local source", options))[0]?.id).toBe(memory.id);
    await expect(readFile(path.join(vault, "memories", "Personal.md"), "utf8")).resolves.toBe(
      "Do not overwrite."
    );
  });

  test("rejects a symlinked managed folder at the vault root", async () => {
    const home = await tempRoot();
    const vault = await tempRoot();
    const external = await tempRoot();
    const options: OpenBrainOptions = { home, brain: "main", embedder: noEmbeddings };
    await mkdir(path.join(vault, ".obsidian"));
    await mkdir(path.join(external, "memories"));
    await writeFile(path.join(external, "memories", "keep.md"), "Do not follow links.", "utf8");
    await symlink(path.join(external, "memories"), path.join(vault, "memories"), "dir");
    const memory = await addMemory({ type: "decision", text: "Keep source data." }, options);

    await expect(
      setBrainStorage("main", { type: "obsidian", vaultPath: vault, layout: "root" }, options)
    ).rejects.toThrow("unsupported file");

    expect((await getBrainStorage("main", { home })).storage).toEqual({ type: "local" });
    expect((await searchMemories("source data", options))[0]?.id).toBe(memory.id);
    await expect(readFile(path.join(external, "memories", "keep.md"), "utf8")).resolves.toBe(
      "Do not follow links."
    );
  });

  test("rolls back a root migration when index rebuilding fails", async () => {
    const home = await tempRoot();
    const vault = await tempRoot();
    const source = path.join(home, "brains", "main");
    await mkdir(path.join(vault, ".obsidian"));
    await mkdir(path.join(source, "memories"), { recursive: true });
    await writeFile(path.join(source, "memories", "broken.md"), "---\nid: broken\n---\n\nBody\n", "utf8");

    await expect(
      setBrainStorage("main", { type: "obsidian", vaultPath: vault, layout: "root" }, { home })
    ).rejects.toThrow("missing type");

    expect((await getBrainStorage("main", { home })).storage).toEqual({ type: "local" });
    await expect(readFile(path.join(source, "memories", "broken.md"), "utf8")).resolves.toContain("Body");
    await expect(stat(path.join(vault, "memories"))).rejects.toThrow();
    await expect(stat(path.join(vault, ".obsidian"))).resolves.toBeDefined();
  });

  test("keeps concurrent source writes and rolls back the staged root", async () => {
    const home = await tempRoot();
    const vault = await tempRoot();
    await mkdir(path.join(vault, ".obsidian"));
    let shouldBlock = false;
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const embedder: EmbeddingProvider = {
      async embed() {
        if (shouldBlock) {
          markStarted();
          await blocked;
        }
        return null;
      }
    };
    const options = { home, embedder };
    await addMemory({ type: "decision", text: "Detect a concurrent brain write." }, options);
    shouldBlock = true;

    const migration = setBrainStorage(
      "main",
      { type: "obsidian", vaultPath: vault, layout: "root" },
      options
    );
    await started;
    const concurrentFile = path.join(home, "brains", "main", "dreams", "concurrent.txt");
    await writeFile(concurrentFile, "Keep this concurrent write.", "utf8");
    release();

    await expect(migration).rejects.toThrow("Brain changed while it was being moved");
    await expect(readFile(concurrentFile, "utf8")).resolves.toBe("Keep this concurrent write.");
    expect((await getBrainStorage("main", { home })).storage).toEqual({ type: "local" });
    await expect(stat(path.join(vault, "memories"))).rejects.toThrow();
  });

  test("allows only one brain to own an Obsidian vault root", async () => {
    const home = await tempRoot();
    const vault = await tempRoot();
    await mkdir(path.join(vault, ".obsidian"));

    await setBrainStorage("main", { type: "obsidian", vaultPath: vault, layout: "root" }, { home });
    await expect(setBrainStorage("other", { type: "obsidian", vaultPath: vault }, { home })).rejects.toThrow(
      "already used by brain main"
    );
    expect((await getBrainStorage("other", { home })).storage).toEqual({ type: "local" });
  });

  test("rejects non-vault destinations without changing configuration", async () => {
    const home = await tempRoot();
    const notVault = await tempRoot();

    await expect(
      setBrainStorage("main", { type: "obsidian", vaultPath: notVault }, { home })
    ).rejects.toThrow("missing .obsidian");
    expect((await getBrainStorage("main", { home })).storage).toEqual({ type: "local" });
  });

  test("does not overwrite an existing destination", async () => {
    const home = await tempRoot();
    const vault = await tempRoot();
    const destination = path.join(vault, "OpenBrain", "brains", "main");
    await mkdir(path.join(vault, ".obsidian"));
    await mkdir(destination, { recursive: true });
    await writeFile(path.join(destination, "keep.txt"), "do not delete", "utf8");

    await expect(setBrainStorage("main", { type: "obsidian", vaultPath: vault }, { home })).rejects.toThrow(
      "destination already exists"
    );
    await expect(readFile(path.join(destination, "keep.txt"), "utf8")).resolves.toBe("do not delete");
  });

  test("attaches an empty local brain to existing Headless Sync data", async () => {
    const home = await tempRoot();
    const vault = await tempRoot();
    const destination = path.join(await realpath(vault), "OpenBrain", "brains", "main");
    await mkdir(path.join(vault, ".obsidian"));
    const memory = await addMemory(
      { type: "decision", text: "Reuse the existing remote brain." },
      { home, brainRoot: destination, embedder: noEmbeddings }
    );

    const result = await setBrainStorage(
      "main",
      { type: "obsidian", vaultPath: vault, sync: "headless" },
      { home, embedder: noEmbeddings }
    );

    expect(result.path).toBe(destination);
    expect((await searchMemories("existing remote", { home, embedder: noEmbeddings }))[0]?.id).toBe(
      memory.id
    );
    await expect(stat(path.join(home, "indexes", "main", "openbrain.db"))).resolves.toBeDefined();
  });

  test("keeps the source when it changes during an existing-vault index rebuild", async () => {
    const home = await tempRoot();
    const vault = await tempRoot();
    const source = path.join(home, "brains", "main");
    const destination = path.join(await realpath(vault), "OpenBrain", "brains", "main");
    await mkdir(path.join(vault, ".obsidian"));
    await addMemory(
      { type: "decision", text: "Do not lose concurrent writes." },
      { home, embedder: noEmbeddings }
    );
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const embedder: EmbeddingProvider = {
      async embed() {
        markStarted();
        await blocked;
        return null;
      }
    };

    const migration = setBrainStorage(
      "main",
      { type: "obsidian", vaultPath: vault, sync: "headless" },
      { home, embedder }
    );
    await started;
    const concurrentFile = path.join(source, "dreams", "concurrent.txt");
    await writeFile(concurrentFile, "keep me", "utf8");
    release();

    await expect(migration).rejects.toThrow("Brain changed while it was being moved");
    await expect(readFile(concurrentFile, "utf8")).resolves.toBe("keep me");
    expect((await getBrainStorage("main", { home })).storage).toEqual({ type: "local" });
  });

  test("rejects overlapping storage through a symlinked home", async () => {
    const physicalHome = await tempRoot();
    const aliasParent = await tempRoot();
    const home = path.join(aliasParent, "home");
    const vault = path.join(physicalHome, "brains", "main", "vault");
    await symlink(physicalHome, home, "dir");
    await mkdir(path.join(vault, ".obsidian"), { recursive: true });

    await expect(setBrainStorage("main", { type: "obsidian", vaultPath: vault }, { home })).rejects.toThrow(
      "must not overlap"
    );
  });

  test("waits for an in-progress brain write before migrating", async () => {
    const home = await tempRoot();
    const vault = await tempRoot();
    await mkdir(path.join(vault, ".obsidian"));
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const embedder: EmbeddingProvider = {
      async embed() {
        markStarted();
        await blocked;
        return null;
      }
    };
    const write = addMemory(
      { type: "decision", text: "finish this write" },
      { home, brainRoot: path.join(home, "brains", "main"), embedder }
    );
    await started;

    let migrated = false;
    const migration = setBrainStorage("main", { type: "obsidian", vaultPath: vault }, { home }).then(
      (result) => {
        migrated = true;
        return result;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(migrated).toBe(false);
    release();
    await write;
    await migration;

    expect((await getBrainStorage("main", { home })).storage.type).toBe("obsidian");
  });

  test("recovers an orphaned migration lock", async () => {
    const home = await tempRoot();
    const lock = path.join(home, "locks", "main.storage");
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, "999999999\n", "utf8");

    await expect(getBrainStatus({ home })).resolves.toEqual({ brain: "main", state: "active" });
    const result = await setBrainStorage("main", { type: "local" }, { home });

    expect(result.moved).toBe(false);
    await expect(stat(lock)).rejects.toThrow();
  });

  test("keeps the source and failed destination when index verification fails", async () => {
    const home = await tempRoot();
    const vault = await tempRoot();
    const source = path.join(home, "brains", "main");
    const destination = path.join(await realpath(vault), "OpenBrain", "brains", "main");
    await mkdir(path.join(vault, ".obsidian"));
    await mkdir(path.join(source, "memories"), { recursive: true });
    await writeFile(path.join(source, "memories", "broken.md"), "---\nid: broken\n---\n\nbody\n", "utf8");

    await expect(
      setBrainStorage("main", { type: "obsidian", vaultPath: vault }, { home, embedder: noEmbeddings })
    ).rejects.toThrow("missing type");
    await expect(stat(path.join(source, "memories", "broken.md"))).resolves.toBeDefined();
    await expect(stat(path.join(destination, "memories", "broken.md"))).resolves.toBeDefined();
    expect((await getBrainStorage("main", { home })).storage).toEqual({ type: "local" });
  });
});
