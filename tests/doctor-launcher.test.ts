import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { updateConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
import { initOpenBrain, syncCodexAgent } from "../src/openbrain.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "openbrain-launcher-test-"));
  roots.push(home);
  const bin = path.join(home, "bin");
  await mkdir(bin);
  const options = {
    home,
    codexHome: path.join(home, "codex"),
    claudeHome: path.join(home, "claude"),
    embedder: {
      disabled: true,
      async embed() {
        return null;
      }
    },
    fetch: (async () => {
      throw new Error("offline");
    }) as typeof fetch
  };
  await initOpenBrain(options);
  vi.stubEnv("PATH", bin);
  const launcher = path.join(bin, "openbrain");
  return {
    home,
    launcher,
    options,
    async writeLauncher(code: string) {
      await writeFile(launcher, `#!${process.execPath}\n${code}\n`, { mode: 0o755 });
    }
  };
}

describe("doctor launcher verification", () => {
  test("starts the resolved executable with version only", async () => {
    const f = await fixture();
    const invoked = path.join(f.home, "invoked.json");
    await f.writeLauncher(
      `require("node:fs").writeFileSync(${JSON.stringify(invoked)}, JSON.stringify(process.argv.slice(2))); console.log("0.12.1");`
    );
    const report = await runDoctor(f.options);
    expect(report.checks.find((check) => check.name === "path")?.status).toBe("ok");
    expect(JSON.parse(await readFile(invoked, "utf8"))).toEqual(["version"]);
  });

  test("rejects a broken first launcher even when a later PATH entry works", async () => {
    const f = await fixture();
    await f.writeLauncher('require("./missing-dist-cli.js");');
    const later = path.join(f.home, "later");
    await mkdir(later);
    await writeFile(path.join(later, "openbrain"), `#!${process.execPath}\nconsole.log("0.12.1");\n`, {
      mode: 0o755
    });
    vi.stubEnv("PATH", path.dirname(f.launcher) + path.delimiter + later);
    const report = await runDoctor(f.options);
    const check = report.checks.find((entry) => entry.name === "path");
    expect(check?.status).not.toBe("ok");
    expect(check?.detail).toContain(f.launcher);
    expect(check?.hint).toBeTruthy();
  });

  test("bounds a launcher that never exits", async () => {
    const f = await fixture();
    await f.writeLauncher('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
    const started = performance.now();
    const report = await runDoctor(f.options);
    expect(report.checks.find((entry) => entry.name === "path")?.status).not.toBe("ok");
    expect(performance.now() - started).toBeLessThan(6000);
  }, 8000);

  test("bounds launcher output", async () => {
    const f = await fixture();
    await f.writeLauncher('process.stdout.write("x".repeat(1024 * 1024));');

    const report = await runDoctor(f.options);
    const check = report.checks.find((entry) => entry.name === "path");

    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("exceeded the version check output limit");
  });

  test("detects an outdated managed instructions block", async () => {
    const f = await fixture();
    await updateConfig((config) => {
      config.agents.codex.enabled = true;
      config.agents.codex.memoryMode = "hook";
    }, f.options);
    await syncCodexAgent(f.options, "hook");
    const instructions = path.join(f.options.codexHome, "AGENTS.md");
    const current = await readFile(instructions, "utf8");
    await writeFile(
      instructions,
      current.replace("After meaningful work, record useful observations", "Outdated OpenBrain instructions"),
      "utf8"
    );

    const report = await runDoctor(f.options);
    const check = report.checks.find((entry) => entry.name === "codex adapter");

    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("outdated");
    expect(check?.hint).toBe("openbrain agents sync codex");
  });
});
