import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
