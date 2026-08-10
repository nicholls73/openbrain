import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  applyUpdate,
  getUpdateNotice,
  isNewerVersion,
  maybePrintUpdateNotice,
  planUpdate
} from "../src/update.js";

const tempRoots: string[] = [];

async function tempHome() {
  const root = await mkdtemp(path.join(tmpdir(), "openbrain-update-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("update notice", () => {
  test("compares semver versions", () => {
    expect(isNewerVersion("0.1.1", "0.1.0")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(false);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
  });

  test("returns a manual update prompt when remote version is newer", async () => {
    const home = await tempHome();
    const fetch = async () =>
      new Response(JSON.stringify({ version: "0.1.1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });

    const notice = await getUpdateNotice({
      home,
      currentVersion: "0.1.0",
      fetch,
      now: () => new Date("2026-06-25T01:00:00.000Z")
    });

    expect(notice).toContain("openbrain: update available 0.1.0 -> 0.1.1");
    expect(notice).toContain("openbrain update");
  });

  test("prints update notices without writing to stderr", async () => {
    const home = await tempHome();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await maybePrintUpdateNotice({
        home,
        currentVersion: "0.1.0",
        fetch: async () => new Response(JSON.stringify({ version: "0.1.1" }), { status: 200 })
      });

      expect(info).toHaveBeenCalledWith(expect.stringContaining("update available"));
      expect(error).not.toHaveBeenCalled();
    } finally {
      info.mockRestore();
      error.mockRestore();
    }
  });

  test("checks at most once per day", async () => {
    const home = await tempHome();
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ version: "0.1.1" }), { status: 200 });
    };
    const options = {
      home,
      currentVersion: "0.1.0",
      fetch,
      now: () => new Date("2026-06-25T01:00:00.000Z")
    };

    await getUpdateNotice(options);
    await getUpdateNotice(options);

    expect(calls).toBe(1);
  });

  test("updates npm installs and runs doctor with the updated CLI", async () => {
    const packageRoot = await tempHome();
    const commands: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const plan = await planUpdate({
      packageRoot,
      currentVersion: "0.1.0",
      fetch: async () => new Response(JSON.stringify({ version: "0.1.1" }), { status: 200 })
    });

    await applyUpdate(plan, {
      cliPath: "/installed/openbrain/dist/cli.js",
      run: async (command, args, env) => {
        commands.push({ command, args, env });
      }
    });

    expect(plan.method).toBe("npm");
    expect(commands.map(({ command, args }) => [command, args])).toEqual([
      ["npm", ["install", "--global", "@nicholls73/openbrain@latest"]],
      [process.execPath, ["/installed/openbrain/dist/cli.js", "doctor"]]
    ]);
  });

  test("updates fallback installs without replacing their existing launcher", async () => {
    const packageRoot = await tempHome();
    await mkdir(path.join(packageRoot, "scripts"));
    await writeFile(path.join(packageRoot, "scripts", "install.sh"), "#!/bin/bash\n", "utf8");
    const commands: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const plan = await planUpdate({
      packageRoot,
      currentVersion: "0.1.0",
      fetch: async () => new Response(JSON.stringify({ version: "0.1.1" }), { status: 200 })
    });

    await applyUpdate(plan, {
      cliPath: "/installed/openbrain/dist/cli.js",
      run: async (command, args, env) => {
        commands.push({ command, args, env });
      }
    });

    expect(plan.method).toBe("installer");
    expect(commands[0]).toMatchObject({
      command: "bash",
      args: [path.join(packageRoot, "scripts", "install.sh")],
      env: {
        OPENBRAIN_INSTALL_DIR: packageRoot,
        OPENBRAIN_REF: "",
        OPENBRAIN_SOURCE_DIR: "",
        OPENBRAIN_SKIP_BIN: "1"
      }
    });
  });

  test("refuses to replace a source checkout", async () => {
    const packageRoot = await tempHome();
    await mkdir(path.join(packageRoot, ".git"));

    await expect(
      planUpdate({
        packageRoot,
        currentVersion: "0.1.0",
        fetch: async () => new Response(JSON.stringify({ version: "0.1.1" }), { status: 200 })
      })
    ).rejects.toThrow("source checkout");
  });
});
