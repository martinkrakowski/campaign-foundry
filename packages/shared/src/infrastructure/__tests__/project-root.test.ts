import { describe, test, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** A fresh copy of the module so its memoization cache starts empty each test. */
const freshProjectRoot = async () => {
  vi.resetModules();
  return (await import("../project-root.js")).projectRoot;
};

describe("projectRoot", () => {
  const origCwd = process.cwd();
  const origEnv = process.env.PROJECT_ROOT;

  afterEach(() => {
    process.chdir(origCwd);
    if (origEnv === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origEnv;
  });

  test("honours the PROJECT_ROOT override", async () => {
    process.env.PROJECT_ROOT = resolve(tmpdir(), "explicit-root");
    const projectRoot = await freshProjectRoot();
    expect(projectRoot()).toBe(resolve(tmpdir(), "explicit-root"));
  });

  test("memoizes after the first resolution", async () => {
    process.env.PROJECT_ROOT = resolve(tmpdir(), "first");
    const projectRoot = await freshProjectRoot();
    const first = projectRoot();
    process.env.PROJECT_ROOT = resolve(tmpdir(), "second"); // changed, but must be ignored
    expect(projectRoot()).toBe(first);
  });

  test("walks up to a repo marker (yarn.lock / turbo.json)", async () => {
    delete process.env.PROJECT_ROOT;
    const projectRoot = await freshProjectRoot();
    // The suite runs from the monorepo root, which carries the marker files.
    expect(projectRoot()).toBe(origCwd);
  });

  test("falls back to cwd when no marker exists up to the filesystem root", async () => {
    delete process.env.PROJECT_ROOT;
    const dir = mkdtempSync(join(tmpdir(), "cf-root-"));
    try {
      process.chdir(dir);
      const projectRoot = await freshProjectRoot();
      expect(projectRoot()).toBe(resolve(process.cwd()));
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
