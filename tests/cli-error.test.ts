import { describe, expect, test } from "vitest";
import { renderCliError } from "../src/cli-error.js";

describe("CLI error rendering", () => {
  test("adds sandbox recovery guidance to permission errors", () => {
    for (const code of ["EACCES", "EPERM", "SQLITE_CANTOPEN", "SQLITE_READONLY_DIRECTORY"]) {
      const rendered = renderCliError(Object.assign(new Error("unable to open database file"), { code }));
      expect(rendered).toContain("unable to open database file");
      expect(rendered).toContain("write allowlist");
      expect(rendered).toContain("memory search, list, show");
      expect(rendered).toContain("rerun this exact command");
    }
  });

  test("leaves other errors untouched", () => {
    expect(renderCliError(new Error("Memory not found: x"))).toBe("Memory not found: x");
    expect(renderCliError(Object.assign(new Error("malformed image"), { code: "SQLITE_CORRUPT" }))).toBe(
      "malformed image"
    );
    expect(renderCliError("plain failure")).toBe("plain failure");
  });
});
