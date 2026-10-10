import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { updateConfig } from "../src/config.js";
import { addMemory } from "../src/memories.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("CLI search budgets complete evidence and metadata and can fetch omitted bodies", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openbrain-cli-evidence-"));
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
          CLAUDE_HOME: path.join(root, "claude"),
          OPENBRAIN_BRAIN: "main",
          CI: "true"
        }
      });
    const text =
      "contextbudget short. " + "Review evidence before deployment. ".repeat(9) + "Only with approval. 🧠";
    const short = await addMemory({ type: "workflow", text }, { home });
    const largeText = "contextbudget large. " + "🧠".repeat(3000);
    const large = await addMemory({ type: "decision", text: largeText }, { home });
    const searched = await run(["memory", "search", "contextbudget"]);
    expect(searched.stdout).toContain(text);
    expect(searched.stdout).toContain(short.id);
    expect(searched.stdout).toContain(`openbrain memory show ${large.id}`);
    expect(searched.stdout).toContain("Incomplete");
    expect(searched.stdout).not.toContain(largeText);
    expect(Buffer.byteLength(searched.stdout)).toBeLessThanOrEqual(8192);
    expect((await run(["memory", "show", large.id])).stdout).toContain(largeText);
    expect((await run(["memory", "search", "nomatch987654"])).stdout).toBe("No memories found.\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
