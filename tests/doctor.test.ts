import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { DoctorCheck, DoctorReport } from "../src/doctor.js";
import { renderDoctorReport, runDoctor } from "../src/doctor.js";
import { addMemory, initOpenBrain, setupOpenBrain } from "../src/openbrain.js";
import { dreamsDir } from "../src/paths.js";
import type { EmbeddingProvider, OpenBrainOptions } from "../src/types.js";

const tempRoots: string[] = [];

async function tempHome() {
  const root = await mkdtemp(path.join(tmpdir(), "openbrain-doctor-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const offlineFetch = (async () => {
  throw new Error("offline");
}) as unknown as typeof fetch;

function options(home: string, embedder?: EmbeddingProvider): OpenBrainOptions {
  return {
    home,
    codexHome: path.join(home, ".codex"),
    claudeHome: path.join(home, ".claude"),
    now: () => new Date("2026-06-04T09:30:00.000Z"),
    embedder
  };
}

function check(report: DoctorReport, name: string): DoctorCheck {
  const found = report.checks.find((entry) => entry.name === name);
  if (!found) {
    throw new Error(`doctor report has no "${name}" check`);
  }
  return found;
}

describe("openbrain doctor", () => {
  test("reports a healthy setup with no failures", async () => {
    const home = await tempHome();
    const embedder: EmbeddingProvider = {
      async embed() {
        return new Array(384).fill(0.05);
      }
    };
    await setupOpenBrain(
      { brainScope: "default", syncCodex: true, syncClaude: true },
      options(home, embedder)
    );
    await addMemory(
      { type: "workflow", text: "Deploy with the release checklist." },
      options(home, embedder)
    );

    const report = await runDoctor({ ...options(home, embedder), fetch: offlineFetch });

    expect(check(report, "node").status).toBe("ok");
    expect(check(report, "version").status).toBe("ok");
    expect(check(report, "version").detail).toContain("release check unavailable");
    expect(check(report, "config").status).toBe("ok");
    expect(check(report, "brain")).toMatchObject({ status: "ok", detail: expect.stringContaining("main") });
    expect(check(report, "database")).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("1 memory indexed")
    });
    expect(check(report, "embeddings")).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("384-dim")
    });
    expect(check(report, "codex adapter").status).toBe("ok");
    expect(check(report, "claude adapter").status).toBe("ok");
    expect(check(report, "claude hook").status).toBe("ok");
    expect(check(report, "review backlog")).toMatchObject({ status: "ok", detail: "no pending reviews" });
    expect(check(report, "duplicates").status).toBe("ok");
    expect(check(report, "claude auto-memory")).toMatchObject({
      status: "warn",
      hint: expect.stringContaining('"autoMemoryEnabled": false')
    });
    expect(report.failures).toBe(0);

    const rendered = renderDoctorReport(report);
    expect(rendered).toContain("ok   brain:");
    expect(rendered).toContain("0 failures");
  });

  test("flags index drift with a rebuild hint", async () => {
    const home = await tempHome();
    const memory = await addMemory({ type: "workflow", text: "Deploy with the checklist." }, options(home));
    // Remove the file behind the index's back to create drift.
    await rm(memory.path, { force: true });

    const report = await runDoctor({ ...options(home), fetch: offlineFetch });

    expect(check(report, "database")).toMatchObject({
      status: "warn",
      hint: expect.stringContaining("index rebuild")
    });
  });

  test("warns with the add-path hint when no brain is assigned", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ brains: { default: "main", unmatched: "ask", pathRules: [] } }, null, 2),
      "utf8"
    );

    const unassigned = path.join(home, "unassigned-project");
    const report = await runDoctor({ ...options(home), cwd: unassigned, fetch: offlineFetch });

    expect(check(report, "brain")).toMatchObject({
      status: "warn",
      hint: expect.stringContaining("openbrain brain add-path")
    });
    // Brain-dependent checks are skipped when no brain is active.
    expect(report.checks.some((entry) => entry.name === "database")).toBe(false);
  });

  test("warns when adapters and the Claude hook are not synced", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));

    const report = await runDoctor({ ...options(home), fetch: offlineFetch });

    expect(check(report, "codex adapter")).toMatchObject({
      status: "warn",
      hint: "openbrain agents sync codex"
    });
    expect(check(report, "claude adapter")).toMatchObject({
      status: "warn",
      hint: "openbrain agents sync claude"
    });
    expect(check(report, "claude hook")).toMatchObject({
      status: "warn",
      hint: "openbrain agents sync claude"
    });
    expect(report.failures).toBe(0);
  });

  async function writePendingReview(home: string, mtime: Date) {
    const dir = dreamsDir({ ...options(home), brain: "main" });
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "2026-05-01-consolidation.md");
    await writeFile(file, "# Consolidation review\n\n- [abc123] duplicate memory\n", "utf8");
    await utimes(file, mtime, mtime);
  }

  test("warns when a pending review is older than the backlog threshold", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    // Doctor's fixed "now" is 2026-06-04; this review has sat for over a month.
    await writePendingReview(home, new Date("2026-05-01T09:00:00.000Z"));

    const report = await runDoctor({ ...options(home), fetch: offlineFetch });

    expect(check(report, "review backlog")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("1 of 1 pending review file"),
      hint: expect.stringContaining('"openbrain review done <file>"')
    });
    expect(check(report, "review backlog").hint).toContain("openbrain review list");
  });

  test("does not warn on a fresh pending review", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    await writePendingReview(home, new Date("2026-06-03T09:00:00.000Z"));

    const report = await runDoctor({ ...options(home), fetch: offlineFetch });

    expect(check(report, "review backlog")).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("1 pending review file")
    });
  });

  test("warns on near-duplicate durable memories", async () => {
    const home = await tempHome();
    const embedder: EmbeddingProvider = {
      async embed() {
        return [1, 0, 0];
      }
    };
    await addMemory(
      { type: "workflow", text: "Always run the release checklist before deploying." },
      options(home, embedder)
    );
    await addMemory(
      { type: "workflow", text: "Run the release checklist prior to every deploy." },
      options(home, embedder)
    );

    const report = await runDoctor({ ...options(home, embedder), fetch: offlineFetch });

    expect(check(report, "duplicates")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("1 group of near-duplicate durable memories"),
      hint: expect.stringContaining("openbrain dream run")
    });
  });

  test("counts overlapping duplicate matches as one group", async () => {
    const home = await tempHome();
    const embedder: EmbeddingProvider = {
      async embed(text) {
        if (text.includes("Memory A")) {
          return [0.9063078, 0.4226183];
        }
        if (text.includes("Memory B")) {
          return [0.9063078, -0.4226183];
        }
        return [1, 0];
      }
    };
    await addMemory({ type: "workflow", text: "Memory A" }, options(home, embedder));
    await addMemory({ type: "workflow", text: "Memory B" }, options(home, embedder));
    await addMemory({ type: "workflow", text: "Memory C" }, options(home, embedder));

    const report = await runDoctor({ ...options(home, embedder), fetch: offlineFetch });

    expect(check(report, "duplicates").detail).toContain("1 group of near-duplicate durable memories");
  });

  test("reports codex as advisory-only and a hooked claude as hook-backed", async () => {
    const home = await tempHome();
    await setupOpenBrain({ brainScope: "default", syncCodex: true, syncClaude: true }, options(home));

    const report = await runDoctor({ ...options(home), fetch: offlineFetch });

    expect(check(report, "codex enforcement")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("advisory-only")
    });
    expect(check(report, "claude enforcement")).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("hook-backed")
    });
  });

  test("reports claude as advisory-only when the SessionStart hook is missing", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));

    const report = await runDoctor({ ...options(home), fetch: offlineFetch });

    expect(check(report, "claude enforcement")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("advisory-only"),
      hint: "openbrain agents sync claude"
    });
  });

  test("warns when the newest memory is older than the stale threshold", async () => {
    const home = await tempHome();
    await addMemory({ type: "workflow", text: "Deploy with the checklist." }, options(home));

    const later = () => new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    const report = await runDoctor({ ...options(home), now: later, fetch: offlineFetch });

    expect(check(report, "staleness")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("agents may not be following")
    });
  });

  test("warns when an empty brain's install is older than the stale threshold", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));

    const later = () => new Date(Date.now() + 40 * 24 * 60 * 60 * 1000);
    const report = await runDoctor({ ...options(home), now: later, fetch: offlineFetch });

    expect(check(report, "staleness")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("agents may not be following")
    });
  });

  test("reports a recently written brain as fresh", async () => {
    const home = await tempHome();
    await addMemory({ type: "workflow", text: "Deploy with the checklist." }, options(home));

    const report = await runDoctor({ ...options(home), now: () => new Date(), fetch: offlineFetch });

    expect(check(report, "staleness").status).toBe("ok");
  });

  test("accepts disabled Claude auto-memory", async () => {
    const home = await tempHome();
    await setupOpenBrain(
      { brainScope: "default", syncCodex: false, syncClaude: true, disableClaudeAutoMemory: true },
      options(home)
    );

    const report = await runDoctor({ ...options(home), fetch: offlineFetch });

    expect(check(report, "claude auto-memory").status).toBe("ok");
  });

  test("fails on an unparseable config", async () => {
    const home = await tempHome();
    await initOpenBrain(options(home));
    await writeFile(path.join(home, "config.json"), "{ not json", "utf8");

    const report = await runDoctor({ ...options(home), fetch: offlineFetch });

    expect(check(report, "config").status).toBe("fail");
    expect(report.failures).toBeGreaterThan(0);
    // Config-dependent checks are skipped rather than crashing doctor.
    expect(report.checks.some((entry) => entry.name === "brain")).toBe(false);
  });
});
