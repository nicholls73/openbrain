import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { updateCheckPath } from "./paths.js";
import type { OpenBrainOptions } from "./types.js";

const PACKAGE_URL = "https://raw.githubusercontent.com/nicholls73/openbrain/main/package.json";
export const INSTALL_COMMAND =
  "curl -fsSL https://raw.githubusercontent.com/nicholls73/openbrain/main/scripts/install.sh | bash";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 1000;

interface UpdateState {
  checkedAt?: string;
}

interface UpdateOptions extends OpenBrainOptions {
  currentVersion?: string;
  fetch?: typeof fetch;
  packageUrl?: string;
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
      return `openbrain: update available ${currentVersion} -> ${latestVersion}. Ask user before updating:\n${INSTALL_COMMAND}`;
    }
  } catch {
    return undefined;
  }

  return undefined;
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

export async function fetchLatestVersion(fetchImpl: typeof fetch = fetch, packageUrl: string = PACKAGE_URL) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
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
