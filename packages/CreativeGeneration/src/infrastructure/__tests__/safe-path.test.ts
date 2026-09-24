import { describe, test, expect } from "vitest";
import { isAbsolute } from "node:path";
import { resolveAssetPath } from "../safe-path.js";

import { projectRoot } from "@campaignfoundry/shared";
describe("resolveAssetPath", () => {
  test("returns undefined for an empty/undefined input", () => {
    expect(resolveAssetPath(undefined, projectRoot())).toBeUndefined();
    expect(resolveAssetPath("", projectRoot())).toBeUndefined();
  });

  test("rejects an absolute path", () => {
    expect(resolveAssetPath("/etc/passwd", projectRoot())).toBeUndefined();
  });

  test("resolves a repo-relative path inside assets/ to an absolute path", () => {
    const resolved = resolveAssetPath("assets/inputs/hydra-logo.png", projectRoot());
    expect(resolved).toBeDefined();
    expect(isAbsolute(resolved as string)).toBe(true);
    expect(resolved).toMatch(/assets\/inputs\/hydra-logo\.png$/);
  });

  test("rejects a path that escapes the assets/ subtree", () => {
    expect(resolveAssetPath("assets/../package.json", projectRoot())).toBeUndefined();
    expect(resolveAssetPath("../secret.png", projectRoot())).toBeUndefined();
  });

  test("rejects the assets/ directory itself (empty relative path)", () => {
    expect(resolveAssetPath("assets", projectRoot())).toBeUndefined();
  });

  test("confines to the root it is given, not the process's project root (D167)", () => {
    const root = "/tmp/tenant-root";
    expect(resolveAssetPath("assets/inputs/x.png", root)).toBe(
      "/tmp/tenant-root/assets/inputs/x.png",
    );
    expect(resolveAssetPath("../assets/x.png", root)).toBeUndefined();
  });
});
