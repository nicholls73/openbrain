import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoots: string[] = [];

async function tempDir() {
  const root = await mkdtemp(path.join(tmpdir(), "openbrain-install-test-"));
  tempRoots.push(root);
  return root;
}

async function installFromLocal(root: string, env: NodeJS.ProcessEnv = {}) {
  const installDir = path.join(root, "app");
  const binDir = path.join(root, "bin");
  await execFileAsync("bash", ["scripts/install.sh"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OPENBRAIN_SOURCE_DIR: repoRoot,
      OPENBRAIN_INSTALL_DIR: installDir,
      OPENBRAIN_BIN_DIR: binDir,
      ...env
    },
    timeout: 60_000
  });
  return { installDir, binDir };
}

async function prepareFailedUpdate(root: string, failAt: "install" | "build") {
  const sourceDir = path.join(root, "source");
  const installDir = path.join(root, "app");
  const binDir = path.join(root, "bin");
  const stubBinDir = path.join(root, "stub-bin");
  const wrapperPath = path.join(binDir, "openbrain");

  await mkdir(path.join(sourceDir), { recursive: true });
  await mkdir(path.join(installDir, "dist"), { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(stubBinDir, { recursive: true });
  await writeFile(
    path.join(sourceDir, "package.json"),
    JSON.stringify({ name: "@nicholls73/openbrain", version: "99.0.0" })
  );
  await writeFile(path.join(installDir, "package.json"), '{"version":"0.12.1"}\n');
  await writeFile(path.join(installDir, "dist", "cli.js"), 'console.log("existing cli")\n');
  await writeFile(
    wrapperPath,
    `#!/usr/bin/env bash\nexec node "${path.join(installDir, "dist", "cli.js")}" "$@"\n`
  );
  await chmod(wrapperPath, 0o755);
  const pnpmStub = path.join(stubBinDir, "pnpm");
  await writeFile(
    pnpmStub,
    `#!/usr/bin/env bash\nif [[ "$1" == "install" && "$FAIL_AT" == "install" ]]; then exit 42; fi\nif [[ "$1" == "build" && "$FAIL_AT" == "build" ]]; then exit 43; fi\n`
  );
  await chmod(pnpmStub, 0o755);

  return {
    installDir,
    wrapperPath,
    env: {
      ...process.env,
      PATH: `${stubBinDir}:${process.env.PATH ?? ""}`,
      OPENBRAIN_SOURCE_DIR: sourceDir,
      OPENBRAIN_INSTALL_DIR: installDir,
      OPENBRAIN_BIN_DIR: binDir,
      FAIL_AT: failAt
    }
  };
}

async function prepareBuiltUpdate(root: string, reportedVersion: string) {
  const scenario = await prepareFailedUpdate(root, "install");
  const stubBinDir = path.join(root, "stub-bin");
  await writeFile(
    path.join(stubBinDir, "pnpm"),
    `#!/usr/bin/env bash\nif [[ "$1" == "build" ]]; then\n  mkdir -p dist\n  printf '%s\\n' 'if (process.argv.includes("--version")) console.log("${reportedVersion}"); else console.log("new cli");' > dist/cli.js\nfi\n`
  );
  await chmod(path.join(stubBinDir, "pnpm"), 0o755);
  return scenario;
}

async function prepareLauncherPublishFailure(root: string) {
  const scenario = await prepareBuiltUpdate(root, "99.0.0");
  const stubBinDir = path.join(root, "stub-bin");
  await writeFile(
    path.join(stubBinDir, "mv"),
    `#!/usr/bin/env bash\ndestination=""\nfor arg in "$@"; do destination="$arg"; done\nif [[ "$destination" == "$FAIL_MV_TARGET" ]]; then exit 44; fi\nexec /bin/mv "$@"\n`
  );
  await chmod(path.join(stubBinDir, "mv"), 0o755);
  return {
    ...scenario,
    env: { ...scenario.env, FAIL_MV_TARGET: path.join(root, "bin", "openbrain") }
  };
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("install script", () => {
  test("has valid bash syntax", async () => {
    await expect(
      execFileAsync("bash", ["-n", "scripts/install.sh"], { cwd: repoRoot })
    ).resolves.toBeDefined();
  });

  test("prints curl install help", async () => {
    const { stdout } = await execFileAsync("bash", ["scripts/install.sh", "--help"], { cwd: repoRoot });

    expect(stdout).toContain("curl -fsSL");
    expect(stdout).toContain("OPENBRAIN_INSTALL_DIR");
    expect(stdout).toContain("OPENBRAIN_SKIP_BIN");
    expect(stdout).toContain("openbrain setup");
    expect(stdout).toContain("latest release");
    expect(stdout).toContain("SHA-256");
  });

  test("verifies release checksums and treats non-release refs as unverified", async () => {
    const script = await readFile(path.join(repoRoot, "scripts", "install.sh"), "utf8");

    expect(script).toContain("releases/download");
    expect(script).toContain("checksum mismatch");
    expect(script).toContain("latest_release_tag");
    expect(script).toContain("installing it unverified");
  });

  test("installs from a local source directory and creates an openbrain executable", async () => {
    const root = await tempDir();
    const { installDir, binDir } = await installFromLocal(root);

    await expect(access(path.join(binDir, "openbrain"), constants.X_OK)).resolves.toBeUndefined();
    await expect(readFile(path.join(installDir, "package.json"), "utf8")).resolves.toContain(
      '"name": "@nicholls73/openbrain"'
    );

    const isolatedEnv = {
      ...process.env,
      OPENBRAIN_HOME: path.join(root, "state"),
      CODEX_HOME: path.join(root, "codex"),
      CLAUDE_HOME: path.join(root, "claude")
    };
    await mkdir(isolatedEnv.OPENBRAIN_HOME, { recursive: true });
    await writeFile(
      path.join(isolatedEnv.OPENBRAIN_HOME, "config.json"),
      JSON.stringify({ brains: { unmatched: "ask" } })
    );
    const { stdout } = await execFileAsync(path.join(binDir, "openbrain"), [], {
      env: isolatedEnv
    });
    expect(stdout).toContain("openbrain init");
    expect(stdout).toContain("openbrain setup");

    const sessionStart = await execFileAsync(path.join(binDir, "openbrain"), ["hook", "session-start"], {
      env: isolatedEnv
    });
    expect(sessionStart.stdout).toContain("OpenBrain has no brain assigned");
    const hookInput = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      cwd: repoRoot,
      prompt: "check isolated install hook"
    });
    const promptSubmit = await execFileAsync(
      "bash",
      [
        "-c",
        `printf '%s' "$1" | "$2" hook user-prompt-submit`,
        "openbrain-hook-test",
        hookInput,
        path.join(binDir, "openbrain")
      ],
      { env: isolatedEnv }
    );
    expect(promptSubmit.stdout).toBe("");

    const packageJson = JSON.parse(await readFile(path.join(installDir, "package.json"), "utf8"));
    for (const argument of ["version", "--version", "-V"]) {
      const result = await execFileAsync(path.join(binDir, "openbrain"), [argument]);
      expect(result.stdout.trim()).toBe(packageJson.version);
    }
  }, 90_000);

  test("can preserve an existing executable wrapper during an update", async () => {
    const root = await tempDir();
    const binDir = path.join(root, "bin");
    const wrapperPath = path.join(binDir, "openbrain");
    const wrapper = "#!/usr/bin/env bash\necho existing wrapper\n";
    await mkdir(binDir, { recursive: true });
    await writeFile(wrapperPath, wrapper);
    await chmod(wrapperPath, 0o755);

    await installFromLocal(root, { OPENBRAIN_SKIP_BIN: "1" });

    await expect(access(path.join(binDir, "openbrain"), constants.X_OK)).resolves.toBeUndefined();
    await expect(readFile(wrapperPath, "utf8")).resolves.toBe(wrapper);
  }, 90_000);

  test.each([
    ["dependency installation", "install", 42],
    ["CLI compilation", "build", 43]
  ] as const)("preserves the working CLI when %s fails", async (_label, failAt, exitCode) => {
    const root = await tempDir();
    const { installDir, wrapperPath, env } = await prepareFailedUpdate(root, failAt);
    const previousWrapper = await readFile(wrapperPath, "utf8");

    await expect(execFileAsync("bash", ["scripts/install.sh"], { cwd: repoRoot, env })).rejects.toMatchObject(
      { code: exitCode }
    );

    await expect(readFile(path.join(installDir, "dist", "cli.js"), "utf8")).resolves.toBe(
      'console.log("existing cli")\n'
    );
    await expect(readFile(wrapperPath, "utf8")).resolves.toBe(previousWrapper);
    const { stdout } = await execFileAsync(wrapperPath, []);
    expect(stdout.trim()).toBe("existing cli");
  });

  test("restores the previous installation if wrapper publication fails", async () => {
    const root = await tempDir();
    const { installDir, wrapperPath, env } = await prepareLauncherPublishFailure(root);
    const previousWrapper = await readFile(wrapperPath, "utf8");

    await expect(execFileAsync("bash", ["scripts/install.sh"], { cwd: repoRoot, env })).rejects.toMatchObject(
      { code: 44 }
    );

    await expect(readFile(path.join(installDir, "dist", "cli.js"), "utf8")).resolves.toBe(
      'console.log("existing cli")\n'
    );
    await expect(readFile(wrapperPath, "utf8")).resolves.toBe(previousWrapper);
    const { stdout } = await execFileAsync(wrapperPath, []);
    expect(stdout.trim()).toBe("existing cli");
  });

  test("preserves the working CLI when staged version validation fails", async () => {
    const root = await tempDir();
    const { installDir, wrapperPath, env } = await prepareBuiltUpdate(root, "88.0.0");
    const previousWrapper = await readFile(wrapperPath, "utf8");

    await expect(execFileAsync("bash", ["scripts/install.sh"], { cwd: repoRoot, env })).rejects.toMatchObject(
      { code: 1 }
    );

    await expect(readFile(path.join(installDir, "dist", "cli.js"), "utf8")).resolves.toBe(
      'console.log("existing cli")\n'
    );
    await expect(readFile(wrapperPath, "utf8")).resolves.toBe(previousWrapper);
    const { stdout } = await execFileAsync(wrapperPath, []);
    expect(stdout.trim()).toBe("existing cli");
  });

  test("updates an existing wrapper to the successfully validated CLI", async () => {
    const root = await tempDir();
    const { installDir, wrapperPath, env } = await prepareBuiltUpdate(root, "99.0.0");

    await execFileAsync("bash", ["scripts/install.sh"], { cwd: repoRoot, env });

    const { stdout } = await execFileAsync(wrapperPath, []);
    expect(stdout.trim()).toBe("new cli");
    await expect(readFile(path.join(installDir, "package.json"), "utf8")).resolves.toContain(
      '"version":"99.0.0"'
    );
  });

  test("recovers the previous installation from a backup after an interrupted swap", async () => {
    const root = await tempDir();
    const { installDir, wrapperPath, env } = await prepareFailedUpdate(root, "install");
    await rename(installDir, `${installDir}.backup.interrupted`);
    await mkdir(`${installDir}.staging.interrupted`);

    await expect(execFileAsync("bash", ["scripts/install.sh"], { cwd: repoRoot, env })).rejects.toMatchObject(
      { code: 42 }
    );

    await expect(readFile(path.join(installDir, "dist", "cli.js"), "utf8")).resolves.toBe(
      'console.log("existing cli")\n'
    );
    const { stdout } = await execFileAsync(wrapperPath, []);
    expect(stdout.trim()).toBe("existing cli");
  });

  test("leaves the installation alone when another installer holds the lock", async () => {
    const root = await tempDir();
    const { installDir, wrapperPath, env } = await prepareFailedUpdate(root, "install");
    const lockDir = `${installDir}.install.lock`;
    await mkdir(lockDir);
    await writeFile(path.join(lockDir, "pid"), `${process.pid}\n`);

    await expect(execFileAsync("bash", ["scripts/install.sh"], { cwd: repoRoot, env })).rejects.toMatchObject(
      { code: 1 }
    );

    await expect(readFile(path.join(installDir, "dist", "cli.js"), "utf8")).resolves.toBe(
      'console.log("existing cli")\n'
    );
    const { stdout } = await execFileAsync(wrapperPath, []);
    expect(stdout.trim()).toBe("existing cli");
  });
});
