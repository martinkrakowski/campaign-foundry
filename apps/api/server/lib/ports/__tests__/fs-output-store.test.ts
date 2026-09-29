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

  test("openOutput returns reason invalid for a path that escapes the root", async () => {
    const store = new FsOutputStore(root);
    await expect(store.openOutput("../../etc/passwd")).resolves.toEqual({
      found: false,
      reason: "invalid",
    });
  });

  test("HIDDEN_AREAS hides exactly cache, jobs, last-opened and orgs, while packages remain served", async () => {
    mkdirSync(join(root, "cache"), { recursive: true });
    writeFileSync(join(root, "cache", "data.json"), "{}");
    mkdirSync(join(root, "jobs"), { recursive: true });
    writeFileSync(join(root, "jobs", "job.json"), "{}");
    mkdirSync(join(root, "last-opened"), { recursive: true });
    writeFileSync(join(root, "last-opened", "data.json"), "{}");
    mkdirSync(join(root, "orgs", "tenant"), { recursive: true });
    writeFileSync(join(root, "orgs", "tenant", "data.json"), "{}");
    mkdirSync(join(root, "packages", "camp", "instagram-feed"), { recursive: true });
    writeFileSync(join(root, "packages", "camp", "instagram-feed", "manifest.json"), "{}");

    const store = new FsOutputStore(root);
    await expect(store.openOutput("cache/data.json")).resolves.toEqual({
      found: false,
      reason: "missing",
    });
    await expect(store.openOutput("jobs/job.json")).resolves.toEqual({
      found: false,
      reason: "missing",
    });
    await expect(store.openOutput("last-opened/data.json")).resolves.toEqual({
      found: false,
      reason: "missing",
    });
    await expect(store.openOutput("orgs/tenant/data.json")).resolves.toEqual({
      found: false,
      reason: "missing",
    });

    const pkgLookup = await store.openOutput("packages/camp/instagram-feed/manifest.json");
    expect(pkgLookup).toMatchObject({
      found: true,
      file: { name: "manifest.json" },
    });
    if (pkgLookup.found) await pkgLookup.file.close();
  });

  // HX1/D181: `packages` is reserved as a campaign id AND a route segment —
  // but it is not a HIDDEN_AREAS store area — but that split does not widen
  // HIDDEN_AREAS to hide every OTHER route segment too. A route-only segment
  // (`templates`, never a store area) must stay servable, exactly as an
  // ordinary campaign-output path would be.
  test("a reserved ROUTE segment that is not a store area is still served output", async () => {
    mkdirSync(join(root, "templates"), { recursive: true });
    writeFileSync(join(root, "templates", "camp.json"), "{}");

    const store = new FsOutputStore(root);
    const lookup = await store.openOutput("templates/camp.json");
    expect(lookup).toMatchObject({ found: true, file: { name: "camp.json" } });
    if (lookup.found) await lookup.file.close();
  });
});
