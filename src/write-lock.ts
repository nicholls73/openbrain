import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BrainUnavailableError, resolveBrain } from "./brains.js";
import { loadConfig } from "./config.js";
import { storageLockPath } from "./paths.js";
import type { OpenBrainOptions } from "./types.js";

const writeLock = Symbol("openbrain.writeLock");
type LockedOptions = OpenBrainOptions & { [writeLock]: true };

export function isBrainWriteLocked(options: OpenBrainOptions): options is LockedOptions {
  return writeLock in options;
}

export async function withBrainWriteLock<T>(
  options: OpenBrainOptions,
  run: (lockedOptions: OpenBrainOptions) => Promise<T>
) {
  if (isBrainWriteLocked(options)) {
    return run(options);
  }
  const config = await loadConfig(options);
  const resolution = resolveBrain(config, options);
  if (!resolution.enabled) {
    throw new BrainUnavailableError(resolution);
  }
  const lock = storageLockPath(resolution.brain, options);
  await acquireWriteLock(lock, resolution.brain);
  try {
    const lockedOptions = { ...options, brain: resolution.brain } as LockedOptions;
    lockedOptions[writeLock] = true;
    return await run(lockedOptions);
  } finally {
    await rm(lock, { force: true });
  }
}

async function acquireWriteLock(lock: string, brain: string) {
  await mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const handle = await open(lock, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const owner = Number((await readFile(lock, "utf8").catch(() => "")).trim());
      const details = await stat(lock).catch(() => undefined);
      if (!details) {
        continue;
      }
      const age = Date.now() - details.mtimeMs;
      if ((owner && processIsRunning(owner)) || (!owner && age < 60_000)) {
        await delay(25);
        continue;
      }
      await rm(lock, { force: true });
    }
  }
  throw new Error(`Timed out waiting for another write to finish for brain ${brain}`);
}

function processIsRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
