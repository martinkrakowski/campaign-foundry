import { describe, test, expect } from "vitest";
import { join, resolve } from "node:path";
import { resolveConfined } from "../confined-path.js";

const base = resolve("/tmp/cf-confine");

describe("resolveConfined", () => {
  test("resolves a nested path under the base directory", () => {
    expect(resolveConfined(base, "briefs", "camp.yaml")).toBe(join(base, "briefs", "camp.yaml"));
  });

  test("rejects a path that escapes the base via ..", () => {
    expect(() => resolveConfined(join(base, "briefs"), "../package.json")).toThrow(
      /Path escapes the allowed directory/,
    );
  });

  test("rejects an absolute segment that leaves the base", () => {
    expect(() => resolveConfined(base, "/etc/passwd")).toThrow(/Path escapes the allowed directory/);
  });

  test("rejects resolving to the base directory itself", () => {
    expect(() => resolveConfined(base)).toThrow(/Path escapes the allowed directory/);
  });

  test("rejects a name that would overwrite a sibling outside the brief asset dir", () => {
    const briefDir = join(base, "assets", "inputs", "camp");
    expect(() => resolveConfined(briefDir, "../hydra-logo.png")).toThrow(
      /Path escapes the allowed directory/,
    );
  });
});
