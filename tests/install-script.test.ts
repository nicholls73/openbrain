import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
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

    const { stdout } = await execFileAsync(path.join(binDir, "openbrain"), [], {
      env: {
        ...process.env,
        OPENBRAIN_HOME: path.join(root, "state")
      }
    });
    expect(stdout).toContain("openbrain init");
    expect(stdout).toContain("openbrain setup");
  }, 90_000);

  test("can preserve an existing executable wrapper during an update", async () => {
    const root = await tempDir();
    const { binDir } = await installFromLocal(root, { OPENBRAIN_SKIP_BIN: "1" });

    await expect(access(path.join(binDir, "openbrain"), constants.X_OK)).rejects.toThrow();
  }, 90_000);
});
