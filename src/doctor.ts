import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.js";
import { listMemoryRows, openDatabase } from "./db.js";
import { createEmbeddingProvider, embedWithTimeout } from "./embeddings.js";
import { CLAUDE_HOOK_COMMAND, getBrainStatus, memoryFiles, OPENBRAIN_BEGIN } from "./openbrain.js";
import { claudeHome, claudeSettingsPath, codexHome, configPath, dreamsDir } from "./paths.js";
import type { OpenBrainConfig, OpenBrainOptions } from "./types.js";
import { fetchLatestVersion, INSTALL_COMMAND, isNewerVersion, readCurrentVersion } from "./update.js";

export interface DoctorCheck {
  status: "ok" | "warn" | "fail";
  name: string;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  warnings: number;
  failures: number;
}

export interface DoctorOptions extends OpenBrainOptions {
  fetch?: typeof fetch;
}

// One command that verifies the whole installation and prints actionable
// fixes, so an agent (or human) can self-diagnose instead of debugging Node
// ABI, PATH, hook, or model problems piecemeal. Every check degrades to a
// warn/fail line; doctor itself never throws.
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  checks.push(nodeCheck());
  checks.push(await versionCheck(options));

  let config: OpenBrainConfig | undefined;
  try {
    config = await loadConfig(options);
    checks.push({ status: "ok", name: "config", detail: configPath(options) });
  } catch (error) {
    checks.push({
      status: "fail",
      name: "config",
      detail: `${configPath(options)} could not be loaded: ${message(error)}`,
      hint: "Fix or remove the file; OpenBrain recreates a default config on next use."
    });
  }
  if (!config) {
    return summarise(checks);
  }

  const activeBrain = await brainCheck(checks, options);
  if (activeBrain) {
    await databaseCheck(checks, { ...options, brain: activeBrain });
    await dreamCheck(checks, { ...options, brain: activeBrain });
  }
  await embeddingsCheck(checks, config, options);

  if (config.agents.codex.enabled) {
    checks.push(await adapterCheck("codex adapter", path.join(codexHome(options), "AGENTS.md"), "codex"));
  }
  if (config.agents.claude.enabled) {
    checks.push(await adapterCheck("claude adapter", path.join(claudeHome(options), "CLAUDE.md"), "claude"));
    checks.push(await claudeHookCheck(options));
    checks.push(await claudeAutoMemoryCheck(options));
  }

  checks.push(await pathCheck());
  return summarise(checks);
}

export function renderDoctorReport(report: DoctorReport) {
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(`${check.status.padEnd(4)} ${check.name}: ${check.detail}`);
    if (check.hint) {
      lines.push(`     fix: ${check.hint}`);
    }
  }
  lines.push("");
  lines.push(
    `${report.failures} failure${report.failures === 1 ? "" : "s"}, ` +
      `${report.warnings} warning${report.warnings === 1 ? "" : "s"}.`
  );
  return lines.join("\n");
}

function nodeCheck(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= 22) {
    return { status: "ok", name: "node", detail: `v${process.versions.node}` };
  }
  return {
    status: "fail",
    name: "node",
    detail: `v${process.versions.node} is older than the required Node 22`,
    hint: "Install Node 22 or newer, then reinstall OpenBrain."
  };
}

async function versionCheck(options: DoctorOptions): Promise<DoctorCheck> {
  let current: string;
  try {
    current = await readCurrentVersion();
  } catch (error) {
    return { status: "warn", name: "version", detail: `could not read installed version: ${message(error)}` };
  }
  try {
    const latest = await fetchLatestVersion(options.fetch ?? fetch);
    if (isNewerVersion(latest, current)) {
      return {
        status: "warn",
        name: "version",
        detail: `${current} (update available: ${latest})`,
        hint: INSTALL_COMMAND
      };
    }
    return { status: "ok", name: "version", detail: `${current} (latest: ${latest})` };
  } catch {
    return { status: "ok", name: "version", detail: `${current} (release check unavailable)` };
  }
}

async function brainCheck(checks: DoctorCheck[], options: DoctorOptions) {
  const cwd = options.cwd ?? process.cwd();
  try {
    const status = await getBrainStatus(options);
    if (status.state === "active") {
      checks.push({ status: "ok", name: "brain", detail: `${status.brain} (active for ${cwd})` });
      return status.brain;
    }
    if (status.state === "ask") {
      checks.push({
        status: "warn",
        name: "brain",
        detail: `no brain assigned to ${cwd}`,
        hint: `openbrain brain add-path <brain> "${cwd}"`
      });
    } else {
      checks.push({ status: "warn", name: "brain", detail: `OpenBrain is disabled for ${cwd}` });
    }
  } catch (error) {
    checks.push({ status: "fail", name: "brain", detail: message(error) });
  }
  return undefined;
}

async function databaseCheck(checks: DoctorCheck[], options: OpenBrainOptions) {
  try {
    const db = await openDatabase(options);
    let indexed: number;
    try {
      indexed = listMemoryRows(db).length;
    } finally {
      db.close();
    }
    const files = (await memoryFiles(options)).length;
    if (indexed === files) {
      checks.push({
        status: "ok",
        name: "database",
        detail: `${indexed} memor${indexed === 1 ? "y" : "ies"} indexed, matching the markdown files on disk`
      });
    } else {
      checks.push({
        status: "warn",
        name: "database",
        detail: `${indexed} memories indexed but ${files} markdown files on disk`,
        hint: "openbrain index rebuild"
      });
    }
  } catch (error) {
    // Surfaces the better-sqlite3 ABI recovery instructions when relevant.
    checks.push({ status: "fail", name: "database", detail: message(error) });
  }
}

async function dreamCheck(checks: DoctorCheck[], options: OpenBrainOptions) {
  try {
    const raw = await readFile(path.join(dreamsDir(options), "state.json"), "utf8");
    const state = JSON.parse(raw) as { lastDreamDate?: string };
    checks.push({
      status: "ok",
      name: "dream",
      detail: state.lastDreamDate ? `last dreamed ${state.lastDreamDate}` : "never dreamed"
    });
  } catch {
    checks.push({
      status: "ok",
      name: "dream",
      detail: "never dreamed (runs automatically once a day per brain)"
    });
  }
}

async function embeddingsCheck(checks: DoctorCheck[], config: OpenBrainConfig, options: DoctorOptions) {
  if (!config.embeddings.enabled) {
    checks.push({ status: "ok", name: "embeddings", detail: "disabled by config; search is FTS-only" });
    return;
  }
  const provider = options.embedder ?? createEmbeddingProvider(config, options);
  if (provider.disabled) {
    checks.push({
      status: "ok",
      name: "embeddings",
      detail: "disabled in this environment; search is FTS-only"
    });
    return;
  }

  const started = Date.now();
  const embedding = await embedWithTimeout(
    provider,
    "openbrain doctor",
    config.embeddings.timeoutMs,
    config.embeddings.loadTimeoutMs
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  if (!embedding) {
    checks.push({
      status: "warn",
      name: "embeddings",
      detail: `no embedding produced within budget (waited ${elapsed}s); search will be FTS-only`,
      hint: "A first run may still be downloading the model; run openbrain doctor again."
    });
    return;
  }
  if (embedding.length !== config.embeddings.dimensions) {
    checks.push({
      status: "warn",
      name: "embeddings",
      detail: `model returned ${embedding.length} dimensions but config expects ${config.embeddings.dimensions}`,
      hint: 'Update embeddings.dimensions in config.json, then run "openbrain index rebuild".'
    });
    return;
  }
  checks.push({
    status: "ok",
    name: "embeddings",
    detail: `${embedding.length}-dim embedding in ${elapsed}s`
  });
}

async function adapterCheck(name: string, file: string, agent: string): Promise<DoctorCheck> {
  try {
    const raw = await readFile(file, "utf8");
    if (raw.includes(OPENBRAIN_BEGIN)) {
      return { status: "ok", name, detail: `OpenBrain block present in ${file}` };
    }
    return {
      status: "warn",
      name,
      detail: `${file} exists but has no OpenBrain block`,
      hint: `openbrain agents sync ${agent}`
    };
  } catch {
    return { status: "warn", name, detail: `${file} not found`, hint: `openbrain agents sync ${agent}` };
  }
}

async function claudeHookCheck(options: OpenBrainOptions): Promise<DoctorCheck> {
  const file = claudeSettingsPath(options);
  try {
    const raw = await readFile(file, "utf8");
    if (raw.includes(CLAUDE_HOOK_COMMAND)) {
      return { status: "ok", name: "claude hook", detail: `SessionStart hook installed in ${file}` };
    }
  } catch {
    // Fall through to the warn below.
  }
  return {
    status: "warn",
    name: "claude hook",
    detail: `SessionStart hook missing from ${file}`,
    hint: "openbrain agents sync claude"
  };
}

// Claude Code's built-in auto-memory defaults to on, so a missing or
// unparseable settings.json still means the competing memory system is active.
async function claudeAutoMemoryCheck(options: OpenBrainOptions): Promise<DoctorCheck> {
  const file = claudeSettingsPath(options);
  try {
    const settings = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    if (settings.autoMemoryEnabled === false) {
      return { status: "ok", name: "claude auto-memory", detail: `disabled in ${file}` };
    }
  } catch {
    // Fall through to the warn below.
  }
  return {
    status: "warn",
    name: "claude auto-memory",
    detail: "Claude Code's built-in auto-memory is enabled and competes with OpenBrain for agent memories",
    hint: `Set "autoMemoryEnabled": false in ${file}, or rerun openbrain setup and consent to disabling it.`
  };
}

async function pathCheck(): Promise<DoctorCheck> {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, "openbrain");
    try {
      await access(candidate, constants.X_OK);
      return { status: "ok", name: "path", detail: candidate };
    } catch {
      // Keep scanning.
    }
  }
  return {
    status: "warn",
    name: "path",
    detail: "openbrain is not on PATH",
    hint: 'Add to your shell profile: export PATH="$HOME/.local/bin:$PATH"'
  };
}

function summarise(checks: DoctorCheck[]): DoctorReport {
  return {
    checks,
    warnings: checks.filter((check) => check.status === "warn").length,
    failures: checks.filter((check) => check.status === "fail").length
  };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
