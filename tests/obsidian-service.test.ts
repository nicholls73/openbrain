import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  getObsidianSyncServiceStatus,
  type ObsidianServiceRuntime,
  startObsidianSyncService,
  stopObsidianSyncService
} from "../src/obsidian-service.js";

const roots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "openbrain-service-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeRuntime(platform: NodeJS.Platform) {
  const home = await tempRoot();
  const bin = path.join(home, "bin");
  const ob = path.join(bin, "ob");
  await mkdir(bin);
  await writeFile(ob, "#!/bin/sh\n", { mode: 0o755, flag: "w" }).catch(async () => {
    await writeFile(ob, "#!/bin/sh\n");
    await chmod(ob, 0o755);
  });
  const calls: Array<[string, string[]]> = [];
  const runtime: ObsidianServiceRuntime = {
    platform,
    home,
    uid: 501,
    path: bin,
    nodePath: "/usr/local/bin/node",
    run(command, args) {
      calls.push([command, args]);
      if (args[0] === "print") {
        return { status: 0, stdout: "state = running\n" };
      }
      if (args.at(-2) === "is-active") {
        return { status: 0, stdout: "active\n" };
      }
      return { status: 0 };
    }
  };
  return { home, calls, runtime };
}

test("installs and starts a macOS LaunchAgent with escaped paths", async () => {
  const { home, calls, runtime } = await fakeRuntime("darwin");
  const vault = path.join(home, 'Vault & "Brain"');

  const status = await startObsidianSyncService(vault, { home: path.join(home, ".openbrain") }, runtime);

  expect(status.state).toBe("running");
  expect(status.serviceFile).toContain(path.join("Library", "LaunchAgents"));
  const plist = await readFile(status.serviceFile!, "utf8");
  expect(plist).toContain("Vault &amp; &quot;Brain&quot;");
  expect(plist).toContain("<string>--continuous</string>");
  expect(plist).toContain("<key>KeepAlive</key>");
  expect(calls.some(([command, args]) => command === "launchctl" && args[0] === "bootstrap")).toBe(true);
  expect(calls.some(([command, args]) => command === "launchctl" && args[0] === "kickstart")).toBe(true);
});

test("stops a macOS LaunchAgent and removes its definition", async () => {
  const { home, calls, runtime } = await fakeRuntime("darwin");
  const vault = path.join(home, "vault");
  const started = await startObsidianSyncService(vault, { home: path.join(home, ".openbrain") }, runtime);

  const stopped = await stopObsidianSyncService(vault, { home: path.join(home, ".openbrain") }, runtime);

  expect(stopped.state).toBe("stopped");
  await expect(stat(started.serviceFile!)).rejects.toThrow();
  expect(calls.some(([command, args]) => command === "launchctl" && args[0] === "bootout")).toBe(true);
});

test("fails when the background process does not stay running", async () => {
  const { home, runtime } = await fakeRuntime("darwin");
  runtime.run = (_command, args) =>
    args[0] === "print" ? { status: 0, stdout: "state = exited\n" } : { status: 0 };

  await expect(
    startObsidianSyncService(path.join(home, "vault"), { home: path.join(home, ".openbrain") }, runtime)
  ).rejects.toThrow("did not stay running");
});

test("installs and enables a Linux user systemd service", async () => {
  const { home, calls, runtime } = await fakeRuntime("linux");
  const vault = path.join(home, "vault with spaces");

  const status = await startObsidianSyncService(vault, { home: path.join(home, ".openbrain") }, runtime);

  expect(status.state).toBe("running");
  expect(status.serviceFile).toContain(path.join(".config", "systemd", "user"));
  const unit = await readFile(status.serviceFile!, "utf8");
  expect(unit).toContain(`--path "${vault}" --continuous`);
  expect(unit).toContain("Restart=always");
  expect(calls).toContainEqual([
    "systemctl",
    ["--user", "enable", "--now", path.basename(status.serviceFile!)]
  ]);
});

test("reports unsupported hosts with the foreground command", async () => {
  const { home, runtime } = await fakeRuntime("win32");
  const vault = path.join(home, "vault");

  const status = await getObsidianSyncServiceStatus(vault, {}, runtime);

  expect(status).toMatchObject({
    supported: false,
    state: "unsupported",
    manualCommand: expect.stringContaining("--continuous")
  });
});
