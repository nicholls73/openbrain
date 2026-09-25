import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalPathForRule, sanitizeBrainName } from "./brains.js";
import { loadConfig, updateConfig } from "./config.js";
import { prepareOpenBrain, resolveBrainRoot } from "./internal.js";
import { rebuildIndex } from "./maintenance.js";
import { brainHome } from "./paths.js";
import type { BrainStorage, OpenBrainOptions } from "./types.js";
import { isBrainWriteLocked, withBrainWriteLock } from "./write-lock.js";

export interface BrainStorageResult {
  brain: string;
  storage: BrainStorage;
  path: string;
  moved: boolean;
  sourceRemoved: boolean;
}

export async function getBrainStorage(
  brain: string,
  options: OpenBrainOptions = {}
): Promise<Omit<BrainStorageResult, "moved" | "sourceRemoved">> {
  const name = sanitizeBrainName(brain);
  const config = await loadConfig(options);
  const storage = config.brains.storage[name] ?? { type: "local" };
  return { brain: name, storage, path: resolveBrainRoot(config, name, options) };
}

export async function setBrainStorage(
  brain: string,
  requested: BrainStorage,
  options: OpenBrainOptions = {}
): Promise<BrainStorageResult> {
  const name = sanitizeBrainName(brain);
  const storage = await normalizeStorage(requested);
  if (!isBrainWriteLocked(options)) {
    return withBrainWriteLock({ ...options, brain: name }, (locked) =>
      setBrainStorage(name, storage, locked)
    );
  }

  let destination: string | undefined;
  let staging: string | undefined;
  try {
    const config = await loadConfig(options);
    const previous = config.brains.storage[name] ?? { type: "local" };
    const currentRoot = resolveBrainRoot(config, name, options);
    const prepared = await prepareOpenBrain({ ...options, brain: name, brainRoot: currentRoot });
    const source = brainHome(prepared.options);
    const nextConfig = structuredClone(config);
    if (storage.type === "local") {
      delete nextConfig.brains.storage[name];
    } else {
      nextConfig.brains.storage[name] = storage;
    }
    destination = resolveBrainRoot(nextConfig, name, options);

    if (source === destination) {
      await saveStorage(name, previous, storage, options);
      return { brain: name, storage, path: destination, moved: false, sourceRemoved: true };
    }
    rejectOverlappingPaths(await canonicalPath(source), await canonicalPath(destination));
    if (await exists(destination)) {
      throw new Error(`Storage destination already exists: ${destination}`);
    }

    const before = await treeManifest(source);
    await mkdir(path.dirname(destination), { recursive: true });
    staging = path.join(
      path.dirname(destination),
      `.${path.basename(destination)}.openbrain-migration-${process.pid}-${Date.now()}`
    );
    await cp(source, staging, {
      recursive: true,
      preserveTimestamps: true,
      filter: (file) => !isTransient(source, file)
    });
    if (JSON.stringify(before) !== JSON.stringify(await treeManifest(staging))) {
      throw new Error("Brain changed while it was being copied; retry after active agents finish");
    }

    await rename(staging, destination);
    staging = undefined;
    await rebaseDreamState(source, destination);
    await rebuildIndex({ ...options, brain: name, brainRoot: destination });
    if (JSON.stringify(before) !== JSON.stringify(await treeManifest(source))) {
      throw new Error("Brain changed while it was being moved; retry after active agents finish");
    }
    await saveStorage(name, previous, storage, options);

    let sourceRemoved = true;
    try {
      await rm(source, { recursive: true });
    } catch {
      sourceRemoved = false;
    }
    return { brain: name, storage, path: destination, moved: true, sourceRemoved };
  } catch (error) {
    if (staging) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

async function normalizeStorage(storage: BrainStorage): Promise<BrainStorage> {
  if (storage.type === "local") {
    return storage;
  }
  if (storage.type !== "obsidian" || !storage.vaultPath?.trim()) {
    throw new Error("Obsidian storage requires --vault <path>");
  }
  const vaultPath = canonicalPathForRule(storage.vaultPath);
  if (!(await stat(path.join(vaultPath, ".obsidian")).catch(() => undefined))?.isDirectory()) {
    throw new Error(`Not an Obsidian vault (missing .obsidian): ${vaultPath}`);
  }
  return { type: "obsidian", vaultPath };
}

async function saveStorage(
  brain: string,
  previous: BrainStorage,
  storage: BrainStorage,
  options: OpenBrainOptions
) {
  await updateConfig((config) => {
    const current = config.brains.storage[brain] ?? { type: "local" };
    if (JSON.stringify(current) !== JSON.stringify(previous)) {
      throw new Error(`Storage configuration changed while brain ${brain} was being moved`);
    }
    if (storage.type === "local") {
      delete config.brains.storage[brain];
    } else {
      config.brains.storage[brain] = storage;
    }
  }, options);
}

async function rebaseDreamState(source: string, destination: string) {
  const file = path.join(destination, "dreams", "state.json");
  try {
    const state = JSON.parse(await readFile(file, "utf8")) as { lastLogPath?: string };
    if (state.lastLogPath?.startsWith(`${source}${path.sep}`)) {
      state.lastLogPath = path.join(destination, path.relative(source, state.lastLogPath));
      await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function rejectOverlappingPaths(source: string, destination: string) {
  const relativeToSource = path.relative(source, destination);
  const relativeToDestination = path.relative(destination, source);
  if (
    (!relativeToSource.startsWith("..") && !path.isAbsolute(relativeToSource)) ||
    (!relativeToDestination.startsWith("..") && !path.isAbsolute(relativeToDestination))
  ) {
    throw new Error("Storage source and destination must not overlap");
  }
}

async function treeManifest(root: string) {
  const files: Array<[string, string]> = [];
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (isTransient(root, file)) {
        continue;
      }
      const details = await lstat(file);
      if (details.isSymbolicLink() || (!details.isDirectory() && !details.isFile())) {
        throw new Error(`Brain storage contains an unsupported file: ${file}`);
      }
      if (details.isDirectory()) {
        await visit(file);
      } else {
        const digest = createHash("sha256")
          .update(await readFile(file))
          .digest("hex");
        files.push([path.relative(root, file), digest]);
      }
    }
  }
  await visit(root);
  return files.sort(([left], [right]) => left.localeCompare(right));
}

function isTransient(root: string, file: string) {
  const relative = path.relative(root, file);
  return (
    relative === "openbrain.db" ||
    relative.startsWith("openbrain.db-") ||
    relative === path.join("dreams", ".lock")
  );
}

async function canonicalPath(value: string): Promise<string> {
  const missing: string[] = [];
  let current = value;
  while (true) {
    try {
      return path.join(await realpath(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

async function exists(file: string) {
  return Boolean(await lstat(file).catch(() => undefined));
}
