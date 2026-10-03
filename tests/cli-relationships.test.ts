import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { updateConfig } from "../src/config.js";
import { parseMemoryFile } from "../src/markdown.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("CLI adds, preserves, replaces and clears relationships, rejecting conflicting flags", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openbrain-cli-relationships-"));
  const home = path.join(root, "brain");
  try {
    await updateConfig(
      (config) => {
        config.embeddings.enabled = false;
      },
      { home }
    );
    const run = (args: string[]) =>
      execFileAsync(process.execPath, [cli, ...args], {
        env: {
          ...process.env,
          OPENBRAIN_HOME: home,
          CODEX_HOME: path.join(root, "codex"),
          CLAUDE_HOME: path.join(root, "claude")
        }
      });
    const added = await run([
      "memory",
      "add",
      "--type",
      "workflow",
      "--text",
      "CLI relationship source.",
      "--related-to",
      "first",
      "--related-to",
      "second"
    ]);
    const [id, file] = added.stdout.trim().split("\t") as [string, string];
    expect((await parseMemoryFile(file)).metadata.relatedTo).toEqual(["first", "second"]);
    await run(["memory", "update", id, "--text", "Preserved relationships."]);
    expect((await parseMemoryFile(file)).metadata.relatedTo).toEqual(["first", "second"]);
    await run([
      "memory",
      "update",
      id,
      "--text",
      "Replaced relationships.",
      "--related-to",
      "third",
      "--related-to",
      "fourth"
    ]);
    expect((await parseMemoryFile(file)).metadata.relatedTo).toEqual(["third", "fourth"]);
    const beforeConflict = await readFile(file, "utf8");
    await expect(
      run([
        "memory",
        "update",
        id,
        "--text",
        "Must not write.",
        "--related-to",
        "first",
        "--clear-related-to"
      ])
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("cannot combine --related-to with --clear-related-to")
    });
    expect(await readFile(file, "utf8")).toBe(beforeConflict);
    await run(["memory", "update", id, "--text", "Cleared relationships.", "--clear-related-to"]);
    expect((await parseMemoryFile(file)).metadata.relatedTo).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
