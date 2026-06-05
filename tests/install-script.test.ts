import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
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

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("install script", () => {
  test("has valid bash syntax", async () => {
    await expect(execFileAsync("bash", ["-n", "scripts/install.sh"], { cwd: repoRoot })).resolves.toBeDefined();
  });

  test("prints curl install help", async () => {
    const { stdout } = await execFileAsync("bash", ["scripts/install.sh", "--help"], { cwd: repoRoot });

    expect(stdout).toContain("curl -fsSL");
    expect(stdout).toContain("OPENBRAIN_INSTALL_DIR");
  });

  test("installs from a local source directory and creates an openbrain executable", async () => {
    const root = await tempDir();
    const installDir = path.join(root, "app");
    const binDir = path.join(root, "bin");

    await execFileAsync("bash", ["scripts/install.sh"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        OPENBRAIN_SOURCE_DIR: repoRoot,
        OPENBRAIN_INSTALL_DIR: installDir,
        OPENBRAIN_BIN_DIR: binDir
      },
      timeout: 60_000
    });

    await expect(access(path.join(binDir, "openbrain"), constants.X_OK)).resolves.toBeUndefined();
    await expect(readFile(path.join(installDir, "package.json"), "utf8")).resolves.toContain("\"name\": \"openbrain\"");

    const { stdout } = await execFileAsync(path.join(binDir, "openbrain"), [], {
      env: {
        ...process.env,
        OPENBRAIN_HOME: path.join(root, "state")
      }
    });
    expect(stdout).toContain("openbrain init");
  }, 90_000);
});
