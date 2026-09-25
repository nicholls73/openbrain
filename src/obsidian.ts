import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { openBrainHome } from "./paths.js";
import { type BrainStorageResult, setBrainStorage } from "./storage.js";
import type { OpenBrainOptions } from "./types.js";

const VAULT_NAME = "brain";

interface CommandResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: NodeJS.ErrnoException;
}

export type ObsidianRunner = (args: string[], capture: boolean) => CommandResult;

export interface ObsidianSyncResult extends BrainStorageResult {
  remoteVaultCreated: boolean;
  vaultPath: string;
}

export async function connectObsidianSync(
  brain: string,
  options: OpenBrainOptions = {},
  run: ObsidianRunner = runObsidian
): Promise<ObsidianSyncResult> {
  checked(run, ["login"]);

  let remotes = remoteVaults(run);
  let matches = remotes.filter((vault) => vault.name === VAULT_NAME);
  if (matches.length > 1) {
    throw new Error(`Multiple Obsidian Sync vaults are named ${VAULT_NAME}; rename extras and retry`);
  }

  const remoteVaultCreated = matches.length === 0;
  if (remoteVaultCreated) {
    checked(run, ["sync-create-remote", "--name", VAULT_NAME, "--encryption", "standard"]);
    remotes = remoteVaults(run);
    matches = remotes.filter((vault) => vault.name === VAULT_NAME);
    if (matches.length !== 1) {
      throw new Error(`Obsidian created ${VAULT_NAME}, but OpenBrain could not find it afterward`);
    }
  }

  const remote = matches[0];
  const locals = localVaults(run);
  const configured = locals.find((vault) => vault.id === remote.id);
  const defaultPath = path.join(openBrainHome(options), "vaults", VAULT_NAME);
  const vaultPath = path.resolve(configured?.path ?? defaultPath);
  const pathConflict = locals.find(
    (vault) => vault.id !== remote.id && path.resolve(vault.path) === vaultPath
  );
  if (pathConflict) {
    throw new Error(`Obsidian Headless already uses ${vaultPath} for another remote vault`);
  }

  await mkdir(path.join(vaultPath, ".obsidian"), { recursive: true });
  if (!configured) {
    checked(run, ["sync-setup", "--vault", remote.id, "--path", vaultPath]);
  }
  checked(run, ["sync", "--path", vaultPath]);

  const storage = await setBrainStorage(brain, { type: "obsidian", vaultPath, sync: "headless" }, options);
  try {
    checked(run, ["sync", "--path", vaultPath]);
  } catch (error) {
    throw new Error(
      `OpenBrain storage is connected, but the final Obsidian upload failed. Retry: ob sync --path ${JSON.stringify(vaultPath)}`,
      { cause: error }
    );
  }
  return { ...storage, remoteVaultCreated, vaultPath };
}

function runObsidian(args: string[], capture: boolean): CommandResult {
  const result = spawnSync("ob", args, {
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit"
  });
  return {
    status: result.status,
    stdout: result.stdout || undefined,
    stderr: result.stderr || undefined,
    error: result.error
  };
}

function checked(run: ObsidianRunner, args: string[], capture = false) {
  const result = run(args, capture);
  if (result.error?.code === "ENOENT") {
    throw new Error("Obsidian Headless is required. Install it with: npm install -g obsidian-headless");
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(`Obsidian Headless failed: ob ${args.join(" ")}${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout ?? "";
}

function remoteVaults(run: ObsidianRunner) {
  const value = json(checked(run, ["sync-list-remote", "--json"], true), "remote vault list") as {
    vaults?: unknown;
    shared?: unknown;
  };
  return [...vaultRecords(value.vaults), ...vaultRecords(value.shared)];
}

function localVaults(run: ObsidianRunner) {
  const value = json(checked(run, ["sync-list-local", "--json"], true), "local vault list") as {
    vaults?: unknown;
  };
  if (!Array.isArray(value.vaults)) {
    throw new Error("Obsidian Headless returned an invalid local vault list");
  }
  return value.vaults.map((vault) => {
    if (!record(vault) || typeof vault.id !== "string" || typeof vault.path !== "string") {
      throw new Error("Obsidian Headless returned an invalid local vault entry");
    }
    return { id: vault.id, path: vault.path };
  });
}

function vaultRecords(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error("Obsidian Headless returned an invalid remote vault list");
  }
  return value.map((vault) => {
    if (!record(vault) || typeof vault.id !== "string" || typeof vault.name !== "string") {
      throw new Error("Obsidian Headless returned an invalid remote vault entry");
    }
    return { id: vault.id, name: vault.name };
  });
}

function json(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Obsidian Headless returned invalid JSON for ${label}`);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}
