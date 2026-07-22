import { spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { updateCheckPath } from "./paths.js";
import type { OpenBrainOptions } from "./types.js";

const PACKAGE_URL = "https://raw.githubusercontent.com/nicholls73/openbrain/main/package.json";
export const UPDATE_COMMAND = "openbrain update";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 1000;
const UPDATE_TIMEOUT_MS = 10_000;
const NPM_PACKAGE = "@nicholls73/openbrain@latest";

interface UpdateState {
  checkedAt?: string;
}

interface UpdateOptions extends OpenBrainOptions {
  currentVersion?: string;
  fetch?: typeof fetch;
  packageUrl?: string;
  packageRoot?: string;
  timeoutMs?: number;
}

export interface UpdatePlan {
  currentVersion: string;
  latestVersion: string;
  method?: "npm" | "installer";
  packageRoot?: string;
}

type UpdateRunner = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;

interface ApplyUpdateOptions {
  cliPath?: string;
  run?: UpdateRunner;
}

export async function maybePrintUpdateNotice(options: UpdateOptions = {}) {
  const notice = await getUpdateNotice(options);
  if (notice) {
    console.error(notice);
  }
}

export async function getUpdateNotice(options: UpdateOptions = {}) {
  if (process.env.OPENBRAIN_UPDATE_CHECK === "0") {
    return undefined;
  }

  try {
    const now = options.now?.() ?? new Date();
    const state = await readUpdateState(options);
    if (state.checkedAt && now.getTime() - Date.parse(state.checkedAt) < CHECK_INTERVAL_MS) {
      return undefined;
    }

    const currentVersion = options.currentVersion ?? (await readCurrentVersion());
    const latestVersion = await fetchLatestVersion(options.fetch ?? fetch, options.packageUrl ?? PACKAGE_URL);
    await writeUpdateState({ checkedAt: now.toISOString() }, options);
    if (isNewerVersion(latestVersion, currentVersion)) {
      return `openbrain: update available ${currentVersion} -> ${latestVersion}. Ask user before updating:\n${UPDATE_COMMAND}`;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export async function planUpdate(options: UpdateOptions = {}): Promise<UpdatePlan> {
  const currentVersion = options.currentVersion ?? (await readCurrentVersion());
  const latestVersion = await fetchLatestVersion(
    options.fetch ?? fetch,
    options.packageUrl ?? PACKAGE_URL,
    options.timeoutMs ?? UPDATE_TIMEOUT_MS
  );
  if (!isNewerVersion(latestVersion, currentVersion)) {
    return { currentVersion, latestVersion };
  }

  const packageRoot = options.packageRoot ?? fileURLToPath(new URL("..", import.meta.url));
  if (await exists(path.join(packageRoot, ".git"))) {
    throw new Error("openbrain update cannot replace a source checkout; update it with git instead");
  }
  const method = (await exists(path.join(packageRoot, "scripts", "install.sh"))) ? "installer" : "npm";
  return { currentVersion, latestVersion, method, packageRoot };
}

export async function applyUpdate(plan: UpdatePlan, options: ApplyUpdateOptions = {}) {
  if (!plan.method || !plan.packageRoot) {
    throw new Error("OpenBrain is already up to date");
  }
  const run = options.run ?? runCommand;
  if (plan.method === "installer") {
    await run("bash", [path.join(plan.packageRoot, "scripts", "install.sh")], {
      ...process.env,
      OPENBRAIN_INSTALL_DIR: plan.packageRoot,
      OPENBRAIN_REF: "",
      OPENBRAIN_SOURCE_DIR: "",
      OPENBRAIN_SKIP_BIN: "1"
    });
  } else {
    await run("npm", ["install", "--global", NPM_PACKAGE], process.env);
  }
  await run(
    process.execPath,
    [options.cliPath ?? fileURLToPath(new URL("./cli.js", import.meta.url)), "doctor"],
    process.env
  );
}

export function isNewerVersion(candidate: string, current: string) {
  const left = parseVersion(candidate);
  const right = parseVersion(current);
  if (!left || !right) {
    return candidate !== current;
  }

  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) {
      return left[index]! > right[index]!;
    }
  }
  return false;
}

export async function readCurrentVersion() {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

export async function fetchLatestVersion(
  fetchImpl: typeof fetch = fetch,
  packageUrl: string = PACKAGE_URL,
  timeoutMs = CHECK_TIMEOUT_MS
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(packageUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`update check failed: ${response.status}`);
    }
    return ((await response.json()) as { version: string }).version;
  } finally {
    clearTimeout(timeout);
  }
}

async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`)
        );
      }
    });
  });
}

async function readUpdateState(options: OpenBrainOptions) {
  try {
    return JSON.parse(await readFile(updateCheckPath(options), "utf8")) as UpdateState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeUpdateState(state: UpdateState, options: OpenBrainOptions) {
  const file = updateCheckPath(options);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function parseVersion(value: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
