import { describe, expect, test } from "vitest";
import { parseSearchArgs } from "../src/search-args.js";

describe("parseSearchArgs", () => {
  test("parses query tokens and options", () => {
    expect(
      parseSearchArgs(["fix", "auth", "--type", "workflow", "--scope", "api", "--confidence", "high"])
    ).toEqual({
      query: "fix auth",
      options: { type: "workflow", scope: "api", confidence: "high" }
    });
  });

  test.each(["--type", "--scope", "--confidence"])("%s at end of args reports a missing value", (flag) => {
    expect(() => parseSearchArgs(["query", flag])).toThrow(`${flag} requires a value`);
  });

  test.each(["--type", "--scope", "--confidence"])(
    "%s followed by another flag reports a missing value",
    (flag) => {
      expect(() => parseSearchArgs(["query", flag, "--durable-only"])).toThrow(`${flag} requires a value`);
    }
  );

  test("accepts an empty string as an option value", () => {
    expect(parseSearchArgs(["query", "--scope", ""])).toEqual({
      query: "query",
      options: { scope: "" }
    });
  });

  test("still rejects invalid values with the value error", () => {
    expect(() => parseSearchArgs(["--type", "nonsense"])).toThrow("--type must be");
    expect(() => parseSearchArgs(["--confidence", "sky-high"])).toThrow("--confidence must be");
  });
});
