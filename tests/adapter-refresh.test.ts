import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { CODEX_HOOK_COMMAND, OPENBRAIN_BEGIN, refreshConfiguredAgentAdapters } from "../src/adapters.js";
import { updateConfig } from "../src/config.js";

const tempRoots: string[] = [];

async function tempOptions() {
  const root = await mkdtemp(path.join(tmpdir(), "openbrain-agent-refresh-test-"));
  tempRoots.push(root);
  return {
    home: path.join(root, "openbrain"),
    codexHome: path.join(root, ".codex"),
    claudeHome: path.join(root, ".claude")
  };
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("configured agent refresh", () => {
  test("updates a stale managed Codex block without moving hooks or user instructions", async () => {
    const options = await tempOptions();
    await updateConfig(() => {}, options);
    await mkdir(options.codexHome, { recursive: true });
    const hooks = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: CODEX_HOOK_COMMAND }] }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "user-hook" }] }]
      }
    };
    const hooksPath = path.join(options.codexHome, "hooks.json");
    await writeFile(hooksPath, `${JSON.stringify(hooks, null, 2)}\n`, "utf8");
    const hookBytes = await readFile(hooksPath);
    const configTomlPath = path.join(options.codexHome, "config.toml");
    const configToml = `[features]\n\n[hooks.state."${hooksPath}:user_prompt_submit:0:0"]\nenabled = false\ntrusted_hash = "existing-trust"\n`;
    await writeFile(configTomlPath, configToml, "utf8");
    const instructionsPath = path.join(options.codexHome, "AGENTS.md");
    await writeFile(
      instructionsPath,
      `User instructions stay here.\n\n${OPENBRAIN_BEGIN}\n## OpenBrain Memory\nOld minimal instructions.\n<!-- END OPENBRAIN -->\n\nKeep this too.\n`,
      "utf8"
    );

    const first = await refreshConfiguredAgentAdapters(options);
    const updated = await readFile(instructionsPath, "utf8");
    const second = await refreshConfiguredAgentAdapters(options);

    expect(first).toEqual([{ agent: "codex", status: "refreshed" }]);
    expect(updated).toContain("After meaningful work, record useful observations before finishing the task.");
    expect(updated).toContain("run `openbrain agents guide codex` for detailed guidance");
    expect(updated).toContain("User instructions stay here.");
    expect(updated).toContain("Keep this too.");
    expect(updated).toMatch(/^User instructions stay here\.\n\n/);
    expect(updated).toMatch(/\n\nKeep this too\.\n$/);
    expect(await readFile(hooksPath)).toEqual(hookBytes);
    expect(await readFile(configTomlPath, "utf8")).toBe(configToml);
    expect(await readFile(instructionsPath, "utf8")).toBe(updated);
    expect(second).toEqual(first);
  });

  test("skips pre-existing agent directories with no OpenBrain setup", async () => {
    const options = await tempOptions();
    await updateConfig(() => {}, options);
    await mkdir(options.codexHome, { recursive: true });
    await mkdir(options.claudeHome, { recursive: true });
    const userHooks = '{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"user-hook"}]}]}}\n';
    const claudeSettings = '{"autoMemoryEnabled":true,"userSetting":"keep"}\n';
    await writeFile(path.join(options.codexHome, "hooks.json"), userHooks, "utf8");
    await writeFile(path.join(options.claudeHome, "settings.json"), claudeSettings, "utf8");

    const results = await refreshConfiguredAgentAdapters(options);

    expect(results).toEqual([]);
    await expect(readFile(path.join(options.codexHome, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(path.join(options.claudeHome, "CLAUDE.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await readFile(path.join(options.codexHome, "hooks.json"), "utf8")).toBe(userHooks);
    expect(await readFile(path.join(options.claudeHome, "settings.json"), "utf8")).toBe(claudeSettings);
  });

  test("leaves disabled integrations untouched", async () => {
    const options = await tempOptions();
    await updateConfig((config) => {
      config.agents.codex.enabled = false;
      config.agents.claude.enabled = false;
    }, options);
    await mkdir(options.codexHome, { recursive: true });
    await mkdir(options.claudeHome, { recursive: true });
    const codexInstructions = `${OPENBRAIN_BEGIN}\nOld Codex block.\n<!-- END OPENBRAIN -->\n`;
    const claudeInstructions = `${OPENBRAIN_BEGIN}\nOld Claude block.\n<!-- END OPENBRAIN -->\n`;
    const hooks = `{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"${CODEX_HOOK_COMMAND}"}]}]}}\n`;
    const settings = `{"autoMemoryEnabled":false,"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"openbrain hook session-start"}]}]}}\n`;
    await writeFile(path.join(options.codexHome, "AGENTS.md"), codexInstructions, "utf8");
    await writeFile(path.join(options.codexHome, "hooks.json"), hooks, "utf8");
    await writeFile(path.join(options.claudeHome, "CLAUDE.md"), claudeInstructions, "utf8");
    await writeFile(path.join(options.claudeHome, "settings.json"), settings, "utf8");

    const results = await refreshConfiguredAgentAdapters(options);

    expect(results).toEqual([
      { agent: "codex", status: "skipped" },
      { agent: "claude", status: "skipped" }
    ]);
    expect(await readFile(path.join(options.codexHome, "AGENTS.md"), "utf8")).toBe(codexInstructions);
    expect(await readFile(path.join(options.codexHome, "hooks.json"), "utf8")).toBe(hooks);
    expect(await readFile(path.join(options.claudeHome, "CLAUDE.md"), "utf8")).toBe(claudeInstructions);
    expect(await readFile(path.join(options.claudeHome, "settings.json"), "utf8")).toBe(settings);
  });

  test("uses the configured manual Codex guidance without changing hook state", async () => {
    const options = await tempOptions();
    await updateConfig((config) => {
      config.agents.codex.memoryMode = "manual";
    }, options);
    await mkdir(options.codexHome, { recursive: true });
    const instructionsPath = path.join(options.codexHome, "AGENTS.md");
    await writeFile(instructionsPath, `${OPENBRAIN_BEGIN}\nOld block.\n<!-- END OPENBRAIN -->\n`, "utf8");
    const hooksPath = path.join(options.codexHome, "hooks.json");
    const hooks = `{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"${CODEX_HOOK_COMMAND}"}]}]}}\n`;
    await writeFile(hooksPath, hooks, "utf8");

    const results = await refreshConfiguredAgentAdapters(options);
    const updated = await readFile(instructionsPath, "utf8");

    expect(results).toEqual([{ agent: "codex", status: "refreshed" }]);
    expect(updated).toContain("openbrain memory search");
    expect(updated).toContain("openbrain dream maybe --quiet");
    expect(await readFile(hooksPath, "utf8")).toBe(hooks);
  });

  test("uses a valid owned hook as proof when no managed instruction block exists", async () => {
    const options = await tempOptions();
    await updateConfig(() => {}, options);
    await mkdir(options.codexHome, { recursive: true });
    await mkdir(options.claudeHome, { recursive: true });
    const codexHooks = `${JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: CODEX_HOOK_COMMAND }] }] }
    })}\n`;
    const claudeSettings = `${JSON.stringify({
      autoMemoryEnabled: false,
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "openbrain hook session-start" }] }] }
    })}\n`;
    await writeFile(path.join(options.codexHome, "hooks.json"), codexHooks, "utf8");
    await writeFile(path.join(options.claudeHome, "settings.json"), claudeSettings, "utf8");

    const results = await refreshConfiguredAgentAdapters(options);

    expect(results).toEqual([
      { agent: "codex", status: "refreshed" },
      { agent: "claude", status: "refreshed" }
    ]);
    expect(await readFile(path.join(options.codexHome, "AGENTS.md"), "utf8")).toContain(OPENBRAIN_BEGIN);
    expect(await readFile(path.join(options.claudeHome, "CLAUDE.md"), "utf8")).toContain(OPENBRAIN_BEGIN);
    expect(await readFile(path.join(options.codexHome, "hooks.json"), "utf8")).toBe(codexHooks);
    expect(await readFile(path.join(options.claudeHome, "settings.json"), "utf8")).toBe(claudeSettings);
  });

  test.each([true, false, undefined])(
    "preserves Claude auto-memory consent (%s)",
    async (autoMemoryEnabled) => {
      const options = await tempOptions();
      await updateConfig(() => {}, options);
      await mkdir(options.claudeHome, { recursive: true });
      const instructionsPath = path.join(options.claudeHome, "CLAUDE.md");
      await writeFile(
        instructionsPath,
        `${OPENBRAIN_BEGIN}\nOld Claude block.\n<!-- END OPENBRAIN -->\n`,
        "utf8"
      );
      const settingsPath = path.join(options.claudeHome, "settings.json");
      const settings: Record<string, unknown> = {
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "openbrain hook session-start" }] }],
          PreToolUse: [{ hooks: [{ type: "command", command: "user-hook" }] }]
        },
        unrelated: { keep: true }
      };
      if (autoMemoryEnabled !== undefined) {
        settings.autoMemoryEnabled = autoMemoryEnabled;
      }
      const original = `${JSON.stringify(settings, null, 2)}\n`;
      await writeFile(settingsPath, original, "utf8");

      const results = await refreshConfiguredAgentAdapters(options);

      expect(results).toEqual([{ agent: "claude", status: "refreshed" }]);
      expect(await readFile(instructionsPath, "utf8")).toContain(
        "After meaningful work, record useful observations."
      );
      expect(await readFile(settingsPath, "utf8")).toBe(original);
    }
  );

  test("reports malformed hook settings as incomplete without rewriting them", async () => {
    const options = await tempOptions();
    await updateConfig(() => {}, options);
    await mkdir(options.codexHome, { recursive: true });
    await mkdir(options.claudeHome, { recursive: true });
    const instructionsPath = path.join(options.codexHome, "AGENTS.md");
    await writeFile(instructionsPath, `${OPENBRAIN_BEGIN}\nOld block.\n<!-- END OPENBRAIN -->\n`, "utf8");
    const hooksPath = path.join(options.codexHome, "hooks.json");
    const malformedHooks = `{"hooks":{"UserPromptSubmit":"bad"},"owned":"${CODEX_HOOK_COMMAND}"}\n`;
    await writeFile(hooksPath, malformedHooks, "utf8");
    const claudeInstructionsPath = path.join(options.claudeHome, "CLAUDE.md");
    await writeFile(
      claudeInstructionsPath,
      `${OPENBRAIN_BEGIN}\nOld Claude block.\n<!-- END OPENBRAIN -->\n`,
      "utf8"
    );
    const settingsPath = path.join(options.claudeHome, "settings.json");
    const malformedSettings = '{"hooks":';
    await writeFile(settingsPath, malformedSettings, "utf8");

    const results = await refreshConfiguredAgentAdapters(options);

    expect(results).toEqual([
      { agent: "codex", status: "incomplete" },
      { agent: "claude", status: "incomplete" }
    ]);
    expect(await readFile(instructionsPath, "utf8")).toContain(
      "After meaningful work, record useful observations before finishing the task."
    );
    expect(await readFile(claudeInstructionsPath, "utf8")).toContain(
      "After meaningful work, record useful observations."
    );
    expect(await readFile(hooksPath, "utf8")).toBe(malformedHooks);
    expect(await readFile(settingsPath, "utf8")).toBe(malformedSettings);
  });

  test("does not infer consent from malformed files that merely mention OpenBrain", async () => {
    const options = await tempOptions();
    await updateConfig(() => {}, options);
    await mkdir(options.codexHome, { recursive: true });
    await mkdir(options.claudeHome, { recursive: true });
    const hooksPath = path.join(options.codexHome, "hooks.json");
    const settingsPath = path.join(options.claudeHome, "settings.json");
    const malformedHooks = `{"note":"${CODEX_HOOK_COMMAND}"`;
    const malformedSettings = '{"note":"openbrain hook session-start"';
    await writeFile(hooksPath, malformedHooks, "utf8");
    await writeFile(settingsPath, malformedSettings, "utf8");

    const results = await refreshConfiguredAgentAdapters(options);

    expect(results).toEqual([]);
    await expect(readFile(path.join(options.codexHome, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(readFile(path.join(options.claudeHome, "CLAUDE.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    expect(await readFile(hooksPath, "utf8")).toBe(malformedHooks);
    expect(await readFile(settingsPath, "utf8")).toBe(malformedSettings);
  });

  test.each([
    `${OPENBRAIN_BEGIN}\nPartial block with no end marker.\n`,
    `<!-- END OPENBRAIN -->\nReversed markers.\n${OPENBRAIN_BEGIN}\n`,
    `${OPENBRAIN_BEGIN}\nFirst block.\n<!-- END OPENBRAIN -->\n${OPENBRAIN_BEGIN}\nSecond block.\n<!-- END OPENBRAIN -->\n`
  ])("reports malformed managed markers without appending another block", async (instructions) => {
    const options = await tempOptions();
    await updateConfig(() => {}, options);
    await mkdir(options.codexHome, { recursive: true });
    const instructionsPath = path.join(options.codexHome, "AGENTS.md");
    await writeFile(instructionsPath, instructions, "utf8");

    const results = await refreshConfiguredAgentAdapters(options);

    expect(results).toEqual([{ agent: "codex", status: "incomplete" }]);
    expect(await readFile(instructionsPath, "utf8")).toBe(instructions);
  });

  test("requires a command hook with the exact owned command to prove setup", async () => {
    const options = await tempOptions();
    await updateConfig(() => {}, options);
    await mkdir(options.claudeHome, { recursive: true });
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "prompt", command: "openbrain hook session-start" }] }]
      }
    };
    await writeFile(path.join(options.claudeHome, "settings.json"), JSON.stringify(settings), "utf8");

    const results = await refreshConfiguredAgentAdapters(options);

    expect(results).toEqual([]);
    await expect(readFile(path.join(options.claudeHome, "CLAUDE.md"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

test("agents refresh CLI reports success and exits nonzero for incomplete instructions", async () => {
  const options = await tempOptions();
  await updateConfig((config) => {
    config.agents.codex.enabled = true;
    config.agents.claude.enabled = false;
  }, options);
  await mkdir(options.codexHome, { recursive: true });
  const instructionsPath = path.join(options.codexHome, "AGENTS.md");
  const original = `${OPENBRAIN_BEGIN}\nOld instructions.\n<!-- END OPENBRAIN -->\n`;
  await writeFile(instructionsPath, original);
  const run = () =>
    promisify(execFile)(
      process.execPath,
      [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "agents", "refresh"],
      {
        env: {
          ...process.env,
          OPENBRAIN_HOME: options.home,
          CODEX_HOME: options.codexHome,
          CLAUDE_HOME: options.claudeHome
        }
      }
    );
  expect((await run()).stdout).toContain("codex: refreshed");
  expect(await readFile(instructionsPath, "utf8")).not.toBe(original);
  const malformed = `${OPENBRAIN_BEGIN}\nMissing end marker.\n`;
  await writeFile(instructionsPath, malformed);
  await expect(run()).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining("codex: incomplete"),
    stderr: expect.stringContaining("Agent instruction refresh is incomplete.")
  });
  expect(await readFile(instructionsPath, "utf8")).toBe(malformed);
});
