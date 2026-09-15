import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveConfined, resolveConfinedForRead } from "../confined-path.js";

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

describe("resolveConfinedForRead", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-confine-read-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("refuses a symlink inside the root pointing outside it", async () => {
    const root = join(dir, "root");
    mkdirSync(root);
    writeFileSync(join(dir, "secret.txt"), "outside");
    symlinkSync(join(dir, "secret.txt"), join(root, "leak.txt"));
    await expect(resolveConfinedForRead(root, "leak.txt")).rejects.toThrow(
      /Path escapes the allowed directory/,
    );
  });

  test("allows a symlink inside the root pointing at another file inside it", async () => {
    const root = join(dir, "root");
    mkdirSync(root);
    writeFileSync(join(root, "real.png"), "inside");
    symlinkSync(join(root, "real.png"), join(root, "alias.png"));
    await expect(resolveConfinedForRead(root, "alias.png")).resolves.toBe(join(root, "alias.png"));
  });

  test("allows a real root reached through a symlinked path", async () => {
    // The macOS /tmp → /private/tmp shape: root itself lives under a symlink.
    const real = join(dir, "real");
    mkdirSync(real);
    writeFileSync(join(real, "a.png"), "x");
    const alias = join(dir, "alias");
    symlinkSync(real, alias);
    await expect(resolveConfinedForRead(alias, "a.png")).resolves.toBe(join(alias, "a.png"));
  });

  test("returns a missing target untouched — today's not-found behaviour stands", async () => {
    const root = join(dir, "root");
    mkdirSync(root);
    await expect(resolveConfinedForRead(root, "nope.png")).resolves.toBe(join(root, "nope.png"));
  });

  test("allows a symlink that resolves to the root itself (a directory 404s downstream)", async () => {
    const root = join(dir, "root");
    mkdirSync(root);
    symlinkSync(root, join(root, "self"));
    await expect(resolveConfinedForRead(root, "self")).resolves.toBe(join(root, "self"));
  });

  test("propagates a non-ENOENT realpath error (ENOTDIR through a file) instead of hiding it", async () => {
    const root = join(dir, "root");
    mkdirSync(root);
    writeFileSync(join(root, "plain.png"), "x");
    const rejection = await resolveConfinedForRead(root, "plain.png", "nested").catch((error: unknown) => error);
    expect((rejection as NodeJS.ErrnoException).code).toBe("ENOTDIR");
  });
});

