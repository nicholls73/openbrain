import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { canonicalPathForRule, sanitizeBrainName } from "./brains.js";
import { loadConfig, updateConfig } from "./config.js";
import { prepareOpenBrain, resolveBrainRoot } from "./internal.js";
import { rebuildIndex } from "./maintenance.js";
import { brainHome, localIndexPath } from "./paths.js";
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
    if (
      (previous.type === "obsidian" && previous.layout === "root") ||
      (storage.type === "obsidian" && storage.layout === "root")
    ) {
      assertRootVaultAvailable(name, storage, config);
      return migrateRootLayout(name, source, destination, previous, storage, options);
    }
    rejectOverlappingPaths(await canonicalPath(source), await canonicalPath(destination));
    const before = await treeManifest(source);
    if (await exists(destination)) {
      if (storage.type !== "obsidian" || storage.sync !== "headless") {
        throw new Error(`Storage destination already exists: ${destination}`);
      }
      const existing = await treeManifest(destination);
      if (before.length > 0 && JSON.stringify(before) !== JSON.stringify(existing)) {
        throw new Error(
          `Both local and Obsidian storage contain data for brain ${name}; refusing to merge them automatically`
        );
      }
      await rebaseDreamState(source, destination);
      await rebuildIndex({
        ...options,
        brain: name,
        brainRoot: destination,
        databasePath: localIndexPath(name, options)
      });
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
    }

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
    await rebuildIndex({
      ...options,
      brain: name,
      brainRoot: destination,
      databasePath:
        storage.type === "obsidian" && storage.sync === "headless" ? localIndexPath(name, options) : undefined
    });
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
  return {
    type: "obsidian",
    vaultPath,
    ...(storage.sync ? { sync: storage.sync } : {}),
    ...(storage.layout ? { layout: storage.layout } : {})
  };
}

const managedBrainDirectories = ["memories", "episodes", "dreams"] as const;

async function migrateRootLayout(
  brain: string,
  source: string,
  destination: string,
  previous: BrainStorage,
  storage: BrainStorage,
  options: OpenBrainOptions
): Promise<BrainStorageResult> {
  const sourceState = await managedBrainState(source);
  const destinationState = await managedBrainState(destination);
  for (const directory of managedBrainDirectories) {
    if (
      destinationState[directory].exists &&
      sourceState[directory].exists &&
      !sameManifest(destinationState[directory].manifest, sourceState[directory].manifest)
    ) {
      throw new Error(
        `Obsidian vault already contains different ${directory} data; refusing to merge it automatically`
      );
    }
  }

  const destinationInfo = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (destinationInfo?.isSymbolicLink() || (destinationInfo && !destinationInfo.isDirectory())) {
    throw new Error(`Storage destination is not a directory: ${destination}`);
  }
  const destinationExisted = Boolean(destinationInfo);
  await mkdir(path.dirname(destination), { recursive: true });
  const stage = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.openbrain-migration-${process.pid}-${Date.now()}`
  );
  const installed: Array<(typeof managedBrainDirectories)[number]> = [];
  let saved = false;
  let stageCreated = false;
  let destinationCreated = false;
  try {
    await mkdir(stage, { recursive: false });
    stageCreated = true;
    if (!destinationExisted) {
      await mkdir(destination);
      destinationCreated = true;
    }
    for (const directory of managedBrainDirectories) {
      if (!sourceState[directory].exists || destinationState[directory].exists) {
        continue;
      }
      await cp(path.join(source, directory), path.join(stage, directory), {
        recursive: true,
        preserveTimestamps: true,
        filter: (file) => !isTransient(source, file)
      });
      const staged = await managedBrainState(stage);
      if (!sameManifest(staged[directory].manifest, sourceState[directory].manifest)) {
        throw new Error(
          `Brain changed while ${directory} was being copied; retry after active agents finish`
        );
      }
    }
    if (!sameManagedBrainState(sourceState, await managedBrainState(source))) {
      throw new Error("Brain changed while it was being moved; retry after active agents finish");
    }
    for (const directory of managedBrainDirectories) {
      if (sourceState[directory].exists && !destinationState[directory].exists) {
        await rename(path.join(stage, directory), path.join(destination, directory));
        installed.push(directory);
      }
    }
    if (!sameManagedBrainContent(sourceState, await managedBrainState(destination))) {
      throw new Error("Brain changed while it was being moved; retry after active agents finish");
    }
    await rebaseDreamState(source, destination);
    const migratedState = await managedBrainState(destination);

    const databasePath =
      storage.type === "obsidian" && (storage.sync === "headless" || storage.layout === "root")
        ? localIndexPath(brain, options)
        : path.join(destination, "openbrain.db");
    await rebuildIndex({ ...options, brain, brainRoot: destination, databasePath });
    if (
      !sameManagedBrainState(sourceState, await managedBrainState(source)) ||
      !sameManagedBrainState(migratedState, await managedBrainState(destination))
    ) {
      throw new Error("Brain changed while it was being moved; retry after active agents finish");
    }
    await saveStorage(brain, previous, storage, options);
    saved = true;
  } catch (error) {
    if (!saved) {
      const retained: string[] = [];
      const current = await managedBrainState(destination).catch(() => undefined);
      for (const directory of installed) {
        if (current && sameManifest(current[directory].manifest, sourceState[directory].manifest)) {
          await rm(path.join(destination, directory), { recursive: true, force: true });
        } else {
          retained.push(path.join(destination, directory));
        }
      }
      if (destinationCreated && !retained.length) {
        await rmdir(destination).catch(() => {});
      }
      if (retained.length) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; rollback left changed data at ${retained.join(", ")}`,
          { cause: error }
        );
      }
    }
    throw error;
  } finally {
    if (stageCreated) {
      await rm(stage, { recursive: true, force: true });
    }
  }

  const sourceRemoved = await removeManagedSource(source, previous);
  return { brain, storage, path: destination, moved: true, sourceRemoved };
}

async function managedBrainState(root: string) {
  const entries = {} as Record<
    (typeof managedBrainDirectories)[number],
    { exists: boolean; manifest: Array<[string, string]> }
  >;
  for (const directory of managedBrainDirectories) {
    const directoryPath = path.join(root, directory);
    const details = await lstat(directoryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (details?.isSymbolicLink() || (details && !details.isDirectory())) {
      throw new Error(`Brain storage contains an unsupported file: ${directoryPath}`);
    }
    entries[directory] = {
      exists: Boolean(details),
      manifest: details ? await treeManifest(directoryPath, directory) : []
    };
  }
  return entries;
}

function sameManifest(left: Array<[string, string]>, right: Array<[string, string]>) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameManagedBrainState(
  left: Awaited<ReturnType<typeof managedBrainState>>,
  right: Awaited<ReturnType<typeof managedBrainState>>
) {
  return managedBrainDirectories.every(
    (directory) =>
      left[directory].exists === right[directory].exists &&
      sameManifest(left[directory].manifest, right[directory].manifest)
  );
}

function sameManagedBrainContent(
  left: Awaited<ReturnType<typeof managedBrainState>>,
  right: Awaited<ReturnType<typeof managedBrainState>>
) {
  return managedBrainDirectories.every((directory) =>
    sameManifest(left[directory].manifest, right[directory].manifest)
  );
}

async function removeManagedSource(root: string, previous: BrainStorage) {
  try {
    for (const directory of managedBrainDirectories) {
      await rm(path.join(root, directory), { recursive: true, force: true });
    }
    if (previous.type === "obsidian" && previous.layout === "root") {
      return true;
    }
    for (const entry of await readdir(root)) {
      if (entry === "openbrain.db" || entry.startsWith("openbrain.db-")) {
        await rm(path.join(root, entry), { force: true });
      }
    }
    await rmdir(root);
    if (previous.type === "obsidian") {
      const vault = path.resolve(previous.vaultPath);
      let parent = path.dirname(root);
      while (parent !== vault && parent.startsWith(`${vault}${path.sep}`)) {
        await rmdir(parent).catch(() => {});
        parent = path.dirname(parent);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function assertRootVaultAvailable(
  brain: string,
  storage: BrainStorage,
  config: Awaited<ReturnType<typeof loadConfig>>
) {
  if (storage.type !== "obsidian") {
    return;
  }
  const vaultPath = path.resolve(storage.vaultPath);
  const conflict = Object.entries(config.brains.storage).find(
    ([otherBrain, candidate]) =>
      otherBrain !== brain &&
      candidate.type === "obsidian" &&
      path.resolve(candidate.vaultPath) === vaultPath &&
      (candidate.layout === "root" || storage.layout === "root")
  );
  if (conflict) {
    throw new Error(`Obsidian vault root is already used by brain ${conflict[0]}`);
  }
}

async function saveStorage(
  brain: string,
  previous: BrainStorage,
  storage: BrainStorage,
  options: OpenBrainOptions
) {
  await updateConfig((config) => {
    assertRootVaultAvailable(brain, storage, config);
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

async function treeManifest(root: string, prefix = "") {
  const files: Array<[string, string]> = [];
  async function visit(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (isTransient(root, file, prefix)) {
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

function isTransient(root: string, file: string, prefix = "") {
  const relative = path.join(prefix, path.relative(root, file));
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
