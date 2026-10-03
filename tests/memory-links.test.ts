import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { openDatabase } from "../src/db.js";
import {
  addMemory,
  deleteMemory,
  listMemories,
  promoteMemory,
  pruneEpisodes,
  rebuildIndex,
  searchMemories,
  updateMemory
} from "../src/openbrain.js";
import type { EmbeddingProvider, OpenBrainOptions } from "../src/types.js";

const homes: string[] = [];
const noEmbeddings: EmbeddingProvider = {
  disabled: true,
  async embed() {
    return null;
  }
};

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function tempHome() {
  const home = await mkdtemp(path.join(tmpdir(), "openbrain-memory-links-"));
  homes.push(home);
  return home;
}

function options(home: string, embedder: EmbeddingProvider = noEmbeddings): OpenBrainOptions {
  return {
    home,
    now: () => new Date("2026-06-04T09:30:00.000Z"),
    embedder
  };
}

const BEGIN = "<!-- BEGIN OPENBRAIN GENERATED LINKS -->";

describe("generated Obsidian links", () => {
  test("persists explicit relations and promotion provenance without indexing or replacing user content", async () => {
    const home = await tempHome();
    const embeddingTexts: string[] = [];
    const config = options(home, {
      async embed(text) {
        embeddingTexts.push(text);
        return [1, 0];
      }
    });
    const target = await addMemory({ type: "workflow", text: "Release checklist target note." }, config);
    const episode = await addMemory({ type: "episode", text: "A reviewed release observation." }, config);
    const source = await addMemory(
      {
        type: "decision",
        text: "Source-body marker with a [handwritten link](../notes/manual.md).",
        metadata: { relatedTo: [target.id] }
      },
      config
    );
    const promoted = await promoteMemory(
      { episodeId: episode.id, type: "workflow", text: "Promoted release guidance." },
      config
    );

    let raw = await readFile(source.path, "utf8");
    raw = raw.replace("type: decision\n", "type: decision\nuserField: keep this value\n");
    await writeFile(source.path, raw, "utf8");

    await rebuildIndex(config);
    const firstBuild = await readFile(source.path, "utf8");
    expect(firstBuild).toContain('relatedTo: ["' + target.id + '"]');
    expect(firstBuild).toContain("userField: keep this value");
    expect(firstBuild).toContain("[Related: Release checklist target note](./");
    expect(firstBuild).toContain("[handwritten link](../notes/manual.md)");
    expect(firstBuild.match(new RegExp(BEGIN, "g"))).toHaveLength(1);

    await rebuildIndex(config);
    expect(await readFile(source.path, "utf8")).toBe(firstBuild);
    await rm(path.join(home, "brains", "main", "openbrain.db"), { force: true });
    await rebuildIndex(config);
    expect(embeddingTexts).toContain(source.title + "\n\n" + source.body);
    expect(await readFile(promoted.path, "utf8")).toContain(
      "[Promoted from: A reviewed release observation](../episodes/" + episode.id + ".md)"
    );

    const rows = await listMemories(config);
    expect(rows.find((memory) => memory.id === source.id)?.metadata.relatedTo).toEqual([target.id]);
    expect(rows.find((memory) => memory.id === promoted.id)?.metadata.promotedFrom).toBe(episode.id);
    const results = await searchMemories("Source-body marker", config);
    expect(results.find((result) => result.id === source.id)?.relatedTo).toEqual([target.id]);

    const db = await openDatabase(config, { readonly: true });
    try {
      const row = db.prepare("SELECT body FROM memories WHERE id = ?").get(source.id) as { body: string };
      expect(row.body).toBe("Source-body marker with a [handwritten link](../notes/manual.md).");
      expect(row.body).not.toContain(BEGIN);
      expect(row.body).not.toContain("Release checklist target note");
    } finally {
      db.close();
    }

    const updated = await updateMemory(
      {
        id: source.id,
        text: "Updated source body with a [new user link](../notes/kept.md)."
      },
      config
    );
    expect(updated.metadata.relatedTo).toEqual([target.id]);
    expect(await readFile(source.path, "utf8")).toContain("[new user link](../notes/kept.md)");
    expect(await readFile(source.path, "utf8")).toContain("[Related: Release checklist target note](./");
  });

  test("refreshes incoming links when a target becomes private, expires, or is deleted", async () => {
    const home = await tempHome();
    const config = options(home);
    const privateTarget = await addMemory({ type: "decision", text: "Private target title." }, config);
    const expiredTarget = await addMemory({ type: "workflow", text: "Soon expired target title." }, config);
    const deletedTarget = await addMemory({ type: "workflow", text: "Deleted target title." }, config);
    const source = await addMemory(
      {
        type: "decision",
        text: "A public source note.",
        metadata: { relatedTo: [privateTarget.id, expiredTarget.id, deletedTarget.id] }
      },
      config
    );

    expect(await readFile(source.path, "utf8")).toContain("Private target title");
    await updateMemory(
      {
        id: privateTarget.id,
        text: "Private target title.",
        metadata: { sensitivity: "private" }
      },
      config
    );
    expect(await readFile(source.path, "utf8")).not.toContain("Private target title");

    await updateMemory(
      {
        id: expiredTarget.id,
        text: "Soon expired target title.",
        metadata: { expiresAt: "2026-06-03T00:00:00.000Z" }
      },
      config
    );
    expect(await readFile(source.path, "utf8")).not.toContain("Soon expired target title");

    await deleteMemory(deletedTarget.id, config);
    const finalSource = await readFile(source.path, "utf8");
    expect(finalSource).not.toContain("Deleted target title");
    expect(finalSource).not.toContain("Private target title");
    expect(finalSource).not.toContain("Soon expired target title");
    expect(finalSource).toContain(
      'relatedTo: ["' + privateTarget.id + '","' + expiredTarget.id + '","' + deletedTarget.id + '"]'
    );
  });

  test("omits a target deleted outside OpenBrain before index rebuild", async () => {
    const config = options(await tempHome());
    const target = await addMemory({ type: "workflow", text: "External deletion target." }, config);
    const source = await addMemory(
      { type: "decision", text: "Source decision.", metadata: { relatedTo: [target.id] } },
      config
    );
    expect(await readFile(source.path, "utf8")).toContain("[Related: External deletion target]");
    await rm(target.path);
    await updateMemory({ id: source.id, text: "Updated source decision." }, config);
    expect(await readFile(source.path, "utf8")).not.toContain("[Related: External deletion target]");
  });

  test("prunes unindexed malformed episodes using the filename retention fallback", async () => {
    const home = await tempHome();
    const config = options(home);
    await addMemory({ type: "decision", text: "Keep this durable decision." }, config);
    const expired = path.join(home, "brains", "main", "episodes", "2020-01-01-malformed.md");
    await writeFile(expired, "---\nid: malformed\n---\n\nOld observation.\n");
    expect(await pruneEpisodes(config)).toContain(expired);
    await expect(readFile(expired)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("removes promotion links when episode pruning deletes the target", async () => {
    const home = await tempHome();
    const beforeExpiry = options(home);
    const episode = await addMemory(
      {
        type: "episode",
        text: "Temporary release observation.",
        metadata: { expiresAt: "2026-06-05T00:00:00.000Z" }
      },
      beforeExpiry
    );
    const promoted = await promoteMemory(
      { episodeId: episode.id, type: "workflow", text: "Reviewed release workflow." },
      beforeExpiry
    );
    expect(await readFile(promoted.path, "utf8")).toContain("[Promoted from: Temporary release observation]");

    await pruneEpisodes({
      ...beforeExpiry,
      now: () => new Date("2026-06-06T00:00:00.000Z")
    });

    expect(await readFile(promoted.path, "utf8")).not.toContain("Temporary release observation");
    await expect(readFile(episode.path, "utf8")).rejects.toThrow();
  });

  test("backfills explicit and promotion links with encoded relative paths, idempotently", async () => {
    const home = await tempHome();
    const config = options(home);
    const base = path.join(home, "brains", "main");
    const memoryDir = path.join(base, "memories");
    const episodeDir = path.join(base, "episodes");
    await mkdir(memoryDir, { recursive: true });
    await mkdir(episodeDir, { recursive: true });
    const targetPath = path.join(memoryDir, "special target (one) #1.md");
    const episodePath = path.join(episodeDir, "source episode (one) #1.md");
    const sourcePath = path.join(memoryDir, "legacy source.md");
    const promotedPath = path.join(memoryDir, "legacy promoted.md");

    await writeFile(
      targetPath,
      [
        "---",
        "id: special-target",
        "type: workflow",
        "title: Target [note]",
        "createdAt: 2026-06-01T00:00:00.000Z",
        "---",
        "",
        "Target body.",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      episodePath,
      [
        "---",
        "id: source-episode",
        "type: episode",
        "title: Source episode",
        "createdAt: 2026-06-01T00:00:00.000Z",
        "---",
        "",
        "Episode body.",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      sourcePath,
      [
        "---",
        "id: legacy-source",
        "type: decision",
        "title: Legacy source",
        "createdAt: 2026-06-01T00:00:00.000Z",
        "relatedTo:",
        "  - special-target",
        "customField: preserve me",
        "---",
        "",
        "Legacy body with [my own link](../elsewhere.md).",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      promotedPath,
      [
        "---",
        "id: legacy-promoted",
        "type: workflow",
        "title: Legacy promoted",
        "createdAt: 2026-06-01T00:00:00.000Z",
        "promotedFrom: source-episode",
        "---",
        "",
        "Promoted body.",
        ""
      ].join("\n"),
      "utf8"
    );

    await rebuildIndex(config);
    const sourceText = await readFile(sourcePath, "utf8");
    expect(sourceText).toContain("[Related: Target \\[note\\]](./special%20target%20%28one%29%20%231.md)");
    expect(sourceText).toContain("customField: preserve me");
    expect(sourceText).toContain("[my own link](../elsewhere.md)");
    expect(await readFile(promotedPath, "utf8")).toContain(
      "[Promoted from: Source episode](../episodes/source%20episode%20%28one%29%20%231.md)"
    );

    await rebuildIndex(config);
    expect(await readFile(sourcePath, "utf8")).toBe(sourceText);
    expect((await readFile(sourcePath, "utf8")).match(new RegExp(BEGIN, "g"))).toHaveLength(1);
    const db = await openDatabase(config, { readonly: true });
    try {
      const row = db.prepare("SELECT body FROM memories WHERE id = ?").get("legacy-source") as {
        body: string;
      };
      expect(row.body).toBe("Legacy body with [my own link](../elsewhere.md).");
    } finally {
      db.close();
    }
  });
});
