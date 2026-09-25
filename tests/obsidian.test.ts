import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { connectObsidianSync, type ObsidianRunner } from "../src/obsidian.js";
import { addMemory } from "../src/openbrain.js";
import type { EmbeddingProvider } from "../src/types.js";

const roots: string[] = [];
const noEmbeddings: EmbeddingProvider = {
  disabled: true,
  async embed() {
    return null;
  }
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "openbrain-obsidian-test-"));
  roots.push(root);
  return root;
}

test("creates and connects the brain Sync vault", async () => {
  const home = await tempRoot();
  await addMemory(
    { type: "decision", text: "Keep this memory in Obsidian Sync." },
    { home, embedder: noEmbeddings }
  );
  const fake = fakeObsidian();

  const result = await connectObsidianSync("main", { home, embedder: noEmbeddings }, fake.run);

  const vault = path.join(home, "vaults", "brain");
  expect(result.remoteVaultCreated).toBe(true);
  expect(fake.calls).toContainEqual(["sync-create-remote", "--name", "brain", "--encryption", "standard"]);
  expect(fake.calls).toContainEqual(["sync-setup", "--vault", "remote-brain", "--path", vault]);
  expect(fake.calls.filter(([command]) => command === "sync")).toHaveLength(2);
  expect((await loadConfig({ home })).brains.storage.main).toEqual({
    type: "obsidian",
    vaultPath: await realpath(vault),
    sync: "headless"
  });
  await expect(stat(path.join(home, "indexes", "main", "openbrain.db"))).resolves.toBeDefined();
  await expect(stat(path.join(vault, "OpenBrain", "brains", "main", "openbrain.db"))).rejects.toThrow();
});

test("reuses the existing remote and local brain vault", async () => {
  const home = await tempRoot();
  const vault = path.join(home, "existing-brain-vault");
  await mkdir(vault, { recursive: true });
  const fake = fakeObsidian({ remoteExists: true, localPath: vault });

  const result = await connectObsidianSync("main", { home, embedder: noEmbeddings }, fake.run);

  expect(result.remoteVaultCreated).toBe(false);
  expect(fake.calls.some(([command]) => command === "sync-create-remote")).toBe(false);
  expect(fake.calls.some(([command]) => command === "sync-setup")).toBe(false);
  await expect(readFile(path.join(home, "config.json"), "utf8")).resolves.toContain('"sync": "headless"');
});

test("fails when the account has ambiguous brain vaults", async () => {
  const home = await tempRoot();
  const fake = fakeObsidian({ duplicateRemote: true });

  await expect(connectObsidianSync("main", { home }, fake.run)).rejects.toThrow(
    "Multiple Obsidian Sync vaults"
  );
  expect(fake.calls).toEqual([["login"], ["sync-list-remote", "--json"]]);
});

function fakeObsidian(
  options: { remoteExists?: boolean; duplicateRemote?: boolean; localPath?: string } = {}
) {
  const calls: string[][] = [];
  let remoteExists = options.remoteExists ?? false;
  const run: ObsidianRunner = (args) => {
    calls.push(args);
    switch (args[0]) {
      case "login":
      case "sync":
      case "sync-setup":
        return { status: 0 };
      case "sync-create-remote":
        remoteExists = true;
        return { status: 0 };
      case "sync-list-remote":
        return {
          status: 0,
          stdout: JSON.stringify({
            vaults: remoteExists
              ? [
                  { id: "remote-brain", name: "brain", region: "auto" },
                  ...(options.duplicateRemote
                    ? [{ id: "remote-brain-2", name: "brain", region: "auto" }]
                    : [])
                ]
              : [],
            shared: []
          })
        };
      case "sync-list-local":
        return {
          status: 0,
          stdout: JSON.stringify({
            vaults: options.localPath
              ? [{ id: "remote-brain", path: options.localPath, host: "sync.example" }]
              : []
          })
        };
      default:
        throw new Error(`Unexpected command: ${args.join(" ")}`);
    }
  };
  if (options.duplicateRemote) {
    remoteExists = true;
  }
  return { calls, run };
}
