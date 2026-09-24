import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("waits for the CLI command before Node can exit", async () => {
  const source = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");

  expect(source).toContain("await main(process.argv.slice(2)).catch");
});
