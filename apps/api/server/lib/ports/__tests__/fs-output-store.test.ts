import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsOutputStore } from "../fs-output-store.js";

describe("FsOutputStore", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cf-output-store-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("an explicit root is read instead of the output root", async () => {
    mkdirSync(join(root, "camp"), { recursive: true });
    writeFileSync(join(root, "camp", "a.png"), "png");
    const lookup = await new FsOutputStore(root).openOutput("camp/a.png");
    expect(lookup).toMatchObject({ found: true, file: { name: "a.png", size: 3 } });
    if (lookup.found) await lookup.file.close();
  });

  test("unsafe campaign or platform ids read as no packages, without touching the tree", async () => {
    const store = new FsOutputStore(root);
    await expect(store.listPackageManifests("../evil")).resolves.toEqual([]);
    await expect(store.listPackageFiles("../evil", "instagram-feed")).resolves.toBeUndefined();
    await expect(store.listPackageFiles("camp", "../evil")).resolves.toBeUndefined();
  });

  test("a package walk skips a symlinked file rather than following it outside the root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "cf-output-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "outside");
      const platform = join(root, "packages", "camp", "instagram-feed");
      mkdirSync(platform, { recursive: true });
      writeFileSync(join(platform, "manifest.json"), "{}");
      symlinkSync(join(outside, "secret.txt"), join(platform, "secret.txt"));
      const files = await new FsOutputStore(root).listPackageFiles("camp", "instagram-feed");
      expect(files?.map((f) => f.name)).toEqual(["manifest.json"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
