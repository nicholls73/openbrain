import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openBrainHome } from "./paths.js";
import type { OpenBrainOptions } from "./types.js";

export interface ServiceCommandResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: NodeJS.ErrnoException;
}

export type ServiceCommandRunner = (command: string, args: string[]) => ServiceCommandResult;

export interface ObsidianSyncServiceStatus {
  supported: boolean;
  state: "running" | "stopped" | "unsupported";
  serviceFile?: string;
  logPath?: string;
  manualCommand?: string;
}

export interface ObsidianSyncServiceManager {
  start(vaultPath: string, options?: OpenBrainOptions): Promise<ObsidianSyncServiceStatus>;
  status(vaultPath: string, options?: OpenBrainOptions): Promise<ObsidianSyncServiceStatus>;
  stop(vaultPath: string, options?: OpenBrainOptions): Promise<ObsidianSyncServiceStatus>;
}

export interface ObsidianServiceRuntime {
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
  path?: string;
  nodePath?: string;
  run: ServiceCommandRunner;
}

export const obsidianSyncServiceManager: ObsidianSyncServiceManager = {
  start: (vaultPath, options) => startObsidianSyncService(vaultPath, options),
  status: (vaultPath, options) => getObsidianSyncServiceStatus(vaultPath, options),
  stop: (vaultPath, options) => stopObsidianSyncService(vaultPath, options)
};

export async function startObsidianSyncService(
  vaultPath: string,
  options: OpenBrainOptions = {},
  runtime: ObsidianServiceRuntime = defaultRuntime()
): Promise<ObsidianSyncServiceStatus> {
  const context = await serviceContext(vaultPath, options, runtime);
  if (!context) {
    return unsupportedStatus(vaultPath);
  }
  await mkdir(path.dirname(context.serviceFile), { recursive: true });
  if (context.logPath) {
    await mkdir(path.dirname(context.logPath), { recursive: true });
  }
  await writeFile(context.serviceFile, context.definition, "utf8");

  if (context.platform === "darwin") {
    runtime.run("launchctl", ["bootout", `${context.domain}/${context.label}`]);
    checked(
      runtime.run("launchctl", ["bootstrap", context.domain, context.serviceFile]),
      "launchctl bootstrap"
    );
    checked(
      runtime.run("launchctl", ["kickstart", "-k", `${context.domain}/${context.label}`]),
      "launchctl kickstart"
    );
  } else {
    checked(runtime.run("systemctl", ["--user", "daemon-reload"]), "systemctl daemon-reload");
    checked(runtime.run("systemctl", ["--user", "enable", "--now", context.label]), "systemctl enable");
  }
  return getObsidianSyncServiceStatus(vaultPath, options, runtime);
}

export async function getObsidianSyncServiceStatus(
  vaultPath: string,
  options: OpenBrainOptions = {},
  runtime: ObsidianServiceRuntime = defaultRuntime()
): Promise<ObsidianSyncServiceStatus> {
  const context = await serviceContext(vaultPath, options, runtime, false);
  if (!context) {
    return unsupportedStatus(vaultPath);
  }
  const installed = await readFile(context.serviceFile, "utf8").then(
    () => true,
    () => false
  );
  if (!installed) {
    return {
      supported: true,
      state: "stopped",
      serviceFile: context.serviceFile,
      ...(context.logPath ? { logPath: context.logPath } : {})
    };
  }
  const result =
    context.platform === "darwin"
      ? runtime.run("launchctl", ["print", `${context.domain}/${context.label}`])
      : runtime.run("systemctl", ["--user", "is-active", context.label]);
  const running =
    result.status === 0 && (context.platform !== "darwin" || /\bstate = running\b/.test(result.stdout ?? ""));
  return {
    supported: true,
    state: running ? "running" : "stopped",
    serviceFile: context.serviceFile,
    ...(context.logPath ? { logPath: context.logPath } : {})
  };
}

export async function stopObsidianSyncService(
  vaultPath: string,
  options: OpenBrainOptions = {},
  runtime: ObsidianServiceRuntime = defaultRuntime()
): Promise<ObsidianSyncServiceStatus> {
  const context = await serviceContext(vaultPath, options, runtime, false);
  if (!context) {
    return unsupportedStatus(vaultPath);
  }
  if (context.platform === "darwin") {
    runtime.run("launchctl", ["bootout", `${context.domain}/${context.label}`]);
  } else {
    runtime.run("systemctl", ["--user", "disable", "--now", context.label]);
  }
  await rm(context.serviceFile, { force: true });
  if (context.platform === "linux") {
    runtime.run("systemctl", ["--user", "daemon-reload"]);
  }
  return {
    supported: true,
    state: "stopped",
    serviceFile: context.serviceFile,
    ...(context.logPath ? { logPath: context.logPath } : {})
  };
}

async function serviceContext(
  vaultPath: string,
  options: OpenBrainOptions,
  runtime: ObsidianServiceRuntime,
  requireOb = true
) {
  const platform = runtime.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    return undefined;
  }
  const canonicalVault = path.resolve(vaultPath);
  const suffix = createHash("sha256").update(canonicalVault).digest("hex").slice(0, 12);
  const obPath = await findExecutable("ob", runtime.path ?? process.env.PATH, requireOb);
  const executable = obPath ?? "ob";
  const servicePath = executablePath(runtime, executable);
  const label = `openbrain-obsidian-sync-${suffix}`;
  const servicePathValue = serviceEnvironmentPath(runtime, executable);

  if (platform === "darwin") {
    const home = runtime.home ?? os.homedir();
    const launchLabel = `com.nicholls73.${label}`;
    const serviceFile = path.join(home, "Library", "LaunchAgents", `${launchLabel}.plist`);
    const logPath = path.join(openBrainHome(options), "logs", `${label}.log`);
    return {
      platform,
      label: launchLabel,
      domain: `gui/${runtime.uid ?? process.getuid?.() ?? 0}`,
      serviceFile,
      logPath,
      definition: launchAgent(launchLabel, servicePath, canonicalVault, servicePathValue, logPath)
    } as const;
  }

  const home = runtime.home ?? os.homedir();
  const unit = `${label}.service`;
  const serviceFile = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
    "systemd",
    "user",
    unit
  );
  return {
    platform,
    label: unit,
    domain: "",
    serviceFile,
    definition: systemdUnit(servicePath, canonicalVault, servicePathValue)
  } as const;
}

function launchAgent(label: string, obPath: string, vaultPath: string, envPath: string, logPath: string) {
  const argumentsXml = [obPath, "sync", "--path", vaultPath, "--continuous"]
    .map((value) => `    <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(envPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function systemdUnit(obPath: string, vaultPath: string, envPath: string) {
  return `[Unit]
Description=OpenBrain Obsidian Sync

[Service]
ExecStart=${systemdQuote(obPath)} sync --path ${systemdQuote(vaultPath)} --continuous
Environment="PATH=${systemdEscape(envPath)}"
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function executablePath(runtime: ObsidianServiceRuntime, obPath: string) {
  return path.isAbsolute(obPath)
    ? obPath
    : path.join(path.dirname(runtime.nodePath ?? process.execPath), obPath);
}

function serviceEnvironmentPath(runtime: ObsidianServiceRuntime, executable: string) {
  return [
    path.dirname(runtime.nodePath ?? process.execPath),
    path.dirname(executable),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin"
  ]
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(path.delimiter);
}

async function findExecutable(name: string, searchPath: string | undefined, required: boolean) {
  for (const directory of (searchPath ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  if (required) {
    throw new Error("Obsidian Headless executable was not found in PATH");
  }
  return undefined;
}

function checked(result: ServiceCommandResult, action: string) {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(`${action} failed${detail ? `: ${detail}` : ""}`);
  }
}

function unsupportedStatus(vaultPath: string): ObsidianSyncServiceStatus {
  return {
    supported: false,
    state: "unsupported",
    manualCommand: `ob sync --path ${JSON.stringify(path.resolve(vaultPath))} --continuous`
  };
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function systemdQuote(value: string) {
  return `"${systemdEscape(value)}"`;
}

function systemdEscape(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
}

function defaultRuntime(): ObsidianServiceRuntime {
  return {
    run(command, args) {
      const result = spawnSync(command, args, { encoding: "utf8" });
      return {
        status: result.status,
        stdout: result.stdout || undefined,
        stderr: result.stderr || undefined,
        error: result.error
      };
    }
  };
}
