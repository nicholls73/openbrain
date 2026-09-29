import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { connectObsidianSync, type ObsidianRunner } from "../src/obsidian.js";
import type { ObsidianSyncServiceManager, ObsidianSyncServiceStatus } from "../src/obsidian-service.js";
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
  const service = fakeService();

  const result = await connectObsidianSync(
    "main",
    { home, embedder: noEmbeddings },
    fake.run,
    service.manager
  );

  const vault = path.join(home, "vaults", "brain");
  expect(result.remoteVaultCreated).toBe(true);
  expect(fake.calls).toContainEqual(["sync-create-remote", "--name", "brain", "--encryption", "standard"]);
  expect(fake.calls).toContainEqual(["sync-setup", "--vault", "remote-brain", "--path", vault]);
  expect(fake.calls.filter(([command]) => command === "sync")).toHaveLength(2);
  expect(service.calls).toEqual(["status", "start"]);
  expect(result.service.state).toBe("running");
  expect((await loadConfig({ home })).brains.storage.main).toEqual({
    type: "obsidian",
    vaultPath: await realpath(vault),
    sync: "headless"
  });
  await expect(stat(path.join(home, "indexes", "main", "openbrain.db"))).resolves.toBeDefined();
  await expect(stat(path.join(vault, "OpenBrain", "brains", "main", "openbrain.db"))).rejects.toThrow();
});

test("puts the brain at the top level of its Sync vault when requested", async () => {
  const home = await tempRoot();
  await addMemory(
    { type: "decision", text: "Make this the root of the Obsidian vault." },
    { home, embedder: noEmbeddings }
  );
  const fake = fakeObsidian();
  const service = fakeService();

  const result = await connectObsidianSync(
    "main",
    { home, embedder: noEmbeddings },
    fake.run,
    service.manager,
    "root"
  );

  const vault = path.join(home, "vaults", "brain");
  expect(result.path).toBe(await realpath(vault));
  expect((await loadConfig({ home })).brains.storage.main).toMatchObject({
    type: "obsidian",
    vaultPath: await realpath(vault),
    sync: "headless",
    layout: "root"
  });
  await expect(stat(path.join(vault, "memories"))).resolves.toBeDefined();
  await expect(stat(path.join(vault, "OpenBrain"))).rejects.toThrow();
  await expect(stat(path.join(home, "indexes", "main", "openbrain.db"))).resolves.toBeDefined();
});

test("keeps root layout when reconnecting to an existing Sync vault", async () => {
  const home = await tempRoot();
  const vault = path.join(home, "vaults", "brain");
  await mkdir(path.join(vault, ".obsidian"), { recursive: true });
  const first = fakeObsidian({ remoteExists: true, localPath: vault });
  await addMemory(
    { type: "decision", text: "Keep the existing root layout." },
    { home, embedder: noEmbeddings }
  );
  await connectObsidianSync(
    "main",
    { home, embedder: noEmbeddings },
    first.run,
    fakeService().manager,
    "root"
  );

  const second = fakeObsidian({ remoteExists: true, localPath: vault });
  await connectObsidianSync("main", { home, embedder: noEmbeddings }, second.run, fakeService().manager);

  expect((await loadConfig({ home })).brains.storage.main).toMatchObject({ layout: "root" });
  await expect(stat(path.join(vault, "memories"))).resolves.toBeDefined();
  await expect(stat(path.join(vault, "OpenBrain"))).rejects.toThrow();
});

test("reuses the existing remote and local brain vault", async () => {
  const home = await tempRoot();
  const vault = path.join(home, "existing-brain-vault");
  await mkdir(vault, { recursive: true });
  const fake = fakeObsidian({ remoteExists: true, localPath: vault });
  const service = fakeService("running");

  const result = await connectObsidianSync(
    "main",
    { home, embedder: noEmbeddings },
    fake.run,
    service.manager
  );

  expect(result.remoteVaultCreated).toBe(false);
  expect(fake.calls.some(([command]) => command === "sync-create-remote")).toBe(false);
  expect(fake.calls.some(([command]) => command === "sync-setup")).toBe(false);
  expect(service.calls).toEqual(["status", "stop", "start"]);
  await expect(readFile(path.join(home, "config.json"), "utf8")).resolves.toContain('"sync": "headless"');
});

test("fails when the account has ambiguous brain vaults", async () => {
  const home = await tempRoot();
  const fake = fakeObsidian({ duplicateRemote: true });

  await expect(connectObsidianSync("main", { home }, fake.run, fakeService().manager)).rejects.toThrow(
    "Multiple Obsidian Sync vaults"
  );
  expect(fake.calls).toEqual([["login"], ["sync-list-remote", "--json"]]);
});

test("rejects another remote configured through a symlink to the brain vault", async () => {
  const home = await tempRoot();
  const vault = path.join(home, "vaults", "brain");
  const alias = path.join(home, "brain-alias");
  await mkdir(vault, { recursive: true });
  await symlink(vault, alias, "dir");
  const fake = fakeObsidian({ remoteExists: true, localPath: alias, localId: "other-remote" });

  await expect(connectObsidianSync("main", { home }, fake.run, fakeService().manager)).rejects.toThrow(
    "already uses"
  );
  expect(fake.calls.some(([command]) => command === "sync-setup")).toBe(false);
});

function fakeObsidian(
  options: { remoteExists?: boolean; duplicateRemote?: boolean; localPath?: string; localId?: string } = {}
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
              ? [{ id: options.localId ?? "remote-brain", path: options.localPath, host: "sync.example" }]
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

function fakeService(initial: ObsidianSyncServiceStatus["state"] = "stopped") {
  const calls: string[] = [];
  let state = initial;
  const result = (): ObsidianSyncServiceStatus => ({ supported: true, state });
  const manager: ObsidianSyncServiceManager = {
    async status() {
      calls.push("status");
      return result();
    },
    async start() {
      calls.push("start");
      state = "running";
      return result();
    },
    async stop() {
      calls.push("stop");
      state = "stopped";
      return result();
    }
  };
  return { calls, manager };
}
