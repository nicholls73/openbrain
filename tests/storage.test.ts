import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { addMemory, getBrainStorage, searchMemories, setBrainStorage } from "../src/openbrain.js";
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

    const moved = await setBrainStorage("main", { type: "obsidian", vaultPath: vault }, options);

    expect(moved.path).toBe(path.join(await realpath(vault), "OpenBrain", "brains", "main"));
    await expect(stat(source)).rejects.toThrow();
    await expect(readFile(path.join(moved.path, "dreams", "attachment.txt"), "utf8")).resolves.toBe("kept");
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

  test("recovers an orphaned migration lock", async () => {
    const home = await tempRoot();
    const lock = path.join(home, "locks", "main.storage");
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, "999999999\n", "utf8");

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
