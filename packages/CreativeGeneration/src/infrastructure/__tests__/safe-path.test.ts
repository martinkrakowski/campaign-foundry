import { describe, test, expect } from "vitest";
import { isAbsolute } from "node:path";
import { resolveAssetPath } from "../safe-path.js";

describe("resolveAssetPath", () => {
  test("returns undefined for an empty/undefined input", () => {
    expect(resolveAssetPath(undefined)).toBeUndefined();
    expect(resolveAssetPath("")).toBeUndefined();
  });

  test("rejects an absolute path", () => {
    expect(resolveAssetPath("/etc/passwd")).toBeUndefined();
  });

  test("resolves a repo-relative path inside assets/ to an absolute path", () => {
    const resolved = resolveAssetPath("assets/inputs/hydra-logo.png");
    expect(resolved).toBeDefined();
    expect(isAbsolute(resolved as string)).toBe(true);
    expect(resolved).toMatch(/assets\/inputs\/hydra-logo\.png$/);
  });

  test("rejects a path that escapes the assets/ subtree", () => {
    expect(resolveAssetPath("assets/../package.json")).toBeUndefined();
    expect(resolveAssetPath("../secret.png")).toBeUndefined();
  });

  test("rejects the assets/ directory itself (empty relative path)", () => {
    expect(resolveAssetPath("assets")).toBeUndefined();
  });
});
