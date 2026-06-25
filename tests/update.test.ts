import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { getUpdateNotice, isNewerVersion } from "../src/update.js";

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
    expect(notice).toContain("scripts/install.sh");
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
});
