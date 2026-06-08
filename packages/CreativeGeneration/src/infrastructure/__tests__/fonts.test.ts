import { describe, test, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh copy so the module's `registered`/`warned` flags reset each test. */
const freshRegister = async () => {
  vi.resetModules();
  return (await import("../fonts.js")).registerBundledFonts;
};

describe("registerBundledFonts", () => {
  const origCwd = process.cwd();
  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
  });

  test("registers the bundled fonts from the repo and is idempotent", async () => {
    const register = await freshRegister();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    register(); // resolves <repo>/assets/fonts
    register(); // second call hits the `registered` short-circuit
    expect(warn).not.toHaveBeenCalled();
  });

  test("warns once (not twice) when no fonts directory is found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-nofonts-"));
    try {
      process.chdir(dir);
      const register = await freshRegister();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      register();
      register();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips an assets/fonts directory that exists but holds no fonts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-emptyfonts-"));
    mkdirSync(join(dir, "assets/fonts"), { recursive: true });
    try {
      process.chdir(dir);
      const register = await freshRegister();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      register();
      expect(warn).toHaveBeenCalledOnce(); // empty dir is skipped → falls through to the warning
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
