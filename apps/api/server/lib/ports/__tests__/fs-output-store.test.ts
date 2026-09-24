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
    // Content where "../evil" would reach if the id guards were dropped, so a
    // missing guard changes the answer instead of landing on an empty path.
    mkdirSync(join(root, "evil", "instagram-feed"), { recursive: true });
    writeFileSync(join(root, "evil", "instagram-feed", "manifest.json"), "{}");
    // "packages/camp/../evil" is "packages/evil".
    mkdirSync(join(root, "packages", "evil"), { recursive: true });
    writeFileSync(join(root, "packages", "evil", "manifest.json"), "{}");
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

  test("the run cache and job records are missing however the path is spelled", async () => {
    mkdirSync(join(root, "cache"), { recursive: true });
    writeFileSync(join(root, "cache", "run.json"), "{}");
    mkdirSync(join(root, "jobs"), { recursive: true });
    writeFileSync(join(root, "jobs", "j.json"), "{}");
    const store = new FsOutputStore(root);
    for (const path of [
      "cache/run.json",
      "camp/../cache/run.json",
      "jobs/j.json",
      "x/../jobs/j.json",
    ]) {
      await expect(store.openOutput(path), path).resolves.toEqual({
        found: false,
        reason: "missing",
      });
    }
  });

  test("a symlink elsewhere in the root that points into the cache is missing too", async () => {
    mkdirSync(join(root, "cache"), { recursive: true });
    writeFileSync(join(root, "cache", "run.json"), "{}");
    mkdirSync(join(root, "public"), { recursive: true });
    symlinkSync(join(root, "cache", "run.json"), join(root, "public", "run.json"));
    await expect(new FsOutputStore(root).openOutput("public/run.json")).resolves.toEqual({
      found: false,
      reason: "missing",
    });
  });

  test("another org's files under orgs/ are never this store's output (review on #575)", async () => {
    mkdirSync(join(root, "orgs", "acme", "reports"), { recursive: true });
    writeFileSync(join(root, "orgs", "acme", "reports", "camp.json"), "{}");
    const store = new FsOutputStore(root);
    for (const path of ["orgs/acme/reports/camp.json", "camp/../orgs/acme/reports/camp.json"]) {
      await expect(store.openOutput(path), path).resolves.toEqual({
        found: false,
        reason: "missing",
      });
    }
  });
});
