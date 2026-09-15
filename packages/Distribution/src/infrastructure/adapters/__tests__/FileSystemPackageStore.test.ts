import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileSystemPackageStore } from "../FileSystemPackageStore.js";
import type { PackageManifest, PackageManifestItem } from "../../../application/ports/out/PackageStorePort.js";
import { platformProfile } from "../../../domain/value-objects/PlatformProfile.vo.js";

const bytes = (): Uint8Array => new Uint8Array([137, 80, 78, 71]);

const manifest = (over: Partial<PackageManifest> = {}): PackageManifest => ({
  campaignId: "camp",
  platformId: "instagram-feed",
  packagedAt: "2026-08-25T12:00:00.000Z",
  skipped: 0,
  included: 0,
  excluded: 0,
  profile: platformProfile("instagram-feed")!,
  items: [],
  ...over,
});

const item = (over: Partial<PackageManifestItem> = {}): PackageManifestItem => ({
  productId: "p1",
  treatment: "classic",
  format: "static",
  source: "renders/p1.png",
  packagedPath: "packages/camp/instagram-feed/alpha/1.png",
  bytes: 4,
  checks: { size: "pass" },
  ...over,
});

describe("FileSystemPackageStore", () => {
  let root: string;
  let store: FileSystemPackageStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cf-package-"));
    store = new FileSystemPackageStore(root, "camp");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("constructor refuses a campaign id that escapes or is not a child segment", () => {
    expect(() => new FileSystemPackageStore(root, "..")).toThrow(/Refusing to write outside the output root/);
    expect(() => new FileSystemPackageStore(root, "")).toThrow(/Refusing to write outside the output root/);
    expect(() => new FileSystemPackageStore(root, ".")).toThrow(/Refusing to write outside the output root/);
  });

  test("readAsset returns the bytes of a source file under the output root", async () => {
    mkdirSync(resolve(root, "alpha"), { recursive: true });
    writeFileSync(resolve(root, "alpha/1x1.png"), bytes());
    expect(Buffer.from(await store.readAsset("alpha/1x1.png")).equals(Buffer.from(bytes()))).toBe(true);
  });

  test("readAsset refuses a path that escapes the output root", async () => {
    await expect(store.readAsset("../escape.png")).rejects.toThrow(
      /Refusing to read outside the output root/,
    );
  });

  test("writePackaged lands under packages/<id>/<platform>/ and returns an output-relative path", async () => {
    const written = bytes();
    const path = await store.writePackaged("instagram-feed", "alpha/1x1.png", written);
    expect(path).toBe("packages/camp/instagram-feed/alpha/1x1.png");
    // Staged, not yet committed — the final dir must not exist until writeManifest.
    expect(existsSync(resolve(root, path))).toBe(false);
    const staged = readdirSync(resolve(root, "packages/camp")).filter((n) =>
      n.startsWith("instagram-feed.staging-"),
    );
    expect(staged).toHaveLength(1);
    const onDisk = readFileSync(resolve(root, "packages/camp", staged[0], "alpha/1x1.png"));
    expect(Buffer.from(written).equals(onDisk)).toBe(true);
  });

  test("writePackaged refuses a relative path that escapes the platform folder", async () => {
    await expect(store.writePackaged("instagram-feed", "../escape.png", bytes())).rejects.toThrow(
      /Refusing to write outside the output root/,
    );
  });

  test("writePackaged refuses a platform id that escapes via ..", async () => {
    await expect(store.writePackaged("..", "x.png", bytes())).rejects.toThrow(
      /Refusing to write outside the output root/,
    );
  });

  test("writePackaged refuses a platform id that is not a child segment", async () => {
    await expect(store.writePackaged("", "x.png", bytes())).rejects.toThrow(
      /Refusing to write outside the output root/,
    );
    await expect(store.writePackaged(".", "x.png", bytes())).rejects.toThrow(
      /Refusing to write outside the output root/,
    );
  });

  test("writeManifest commits the staging dir atomically and writes JSON", async () => {
    await store.writePackaged("instagram-feed", "alpha/1x1.png", bytes());
    const path = await store.writeManifest("instagram-feed", manifest());
    expect(path).toBe("packages/camp/instagram-feed/manifest.json");
    const parsed = JSON.parse(readFileSync(resolve(root, path), "utf8")) as PackageManifest;
    expect(parsed.platformId).toBe("instagram-feed");
    expect(parsed.packagedAt).toBe("2026-08-25T12:00:00.000Z");
    expect(existsSync(resolve(root, "packages/camp/instagram-feed/alpha/1x1.png"))).toBe(true);
    const leftover = readdirSync(resolve(root, "packages/camp")).filter((n) => n.includes(".staging-"));
    expect(leftover).toEqual([]);
  });

  test("writeManifest refuses a platform id that escapes via ..", async () => {
    await expect(store.writeManifest("..", manifest())).rejects.toThrow(
      /Refusing to write outside the output root/,
    );
  });

  test("re-packaging with fewer assets leaves no stale files", async () => {
    await store.writePackaged("instagram-feed", "alpha/1x1.png", bytes());
    await store.writePackaged("instagram-feed", "beta/1x1.png", bytes());
    await store.writeManifest("instagram-feed", manifest());
    expect(existsSync(resolve(root, "packages/camp/instagram-feed/beta/1x1.png"))).toBe(true);

    const again = new FileSystemPackageStore(root, "camp");
    await again.writePackaged("instagram-feed", "alpha/1x1.png", bytes());
    await again.writeManifest("instagram-feed", manifest());
    expect(existsSync(resolve(root, "packages/camp/instagram-feed/alpha/1x1.png"))).toBe(true);
    expect(existsSync(resolve(root, "packages/camp/instagram-feed/beta/1x1.png"))).toBe(false);
  });

  test("a failed package never leaves a mixed final directory; a later commit drops leftover staging", async () => {
    await store.writePackaged("instagram-feed", "alpha/1x1.png", bytes());
    expect(existsSync(resolve(root, "packages/camp/instagram-feed"))).toBe(false);

    const again = new FileSystemPackageStore(root, "camp");
    await again.writePackaged("instagram-feed", "alpha/1x1.png", bytes());
    await again.writeManifest("instagram-feed", manifest());
    const names = readdirSync(resolve(root, "packages/camp"));
    expect(names).toEqual(["instagram-feed"]);
  });

  test("writeManifest with no prior writePackaged still commits an empty platform dir", async () => {
    const path = await store.writeManifest("linkedin", manifest({ platformId: "linkedin" }));
    expect(path).toBe("packages/camp/linkedin/manifest.json");
    expect(existsSync(resolve(root, path))).toBe(true);
  });

  test("a staging dir removed by a concurrent store's sweep makes the next write reject instead of silently resurrecting it, and a prior committed package for that platform is untouched", async () => {
    // A prior, legitimate package run for this platform already committed.
    const prior = new FileSystemPackageStore(root, "camp");
    await prior.writePackaged("instagram-feed", "alpha/old.png", bytes());
    await prior.writeManifest("instagram-feed", manifest());
    expect(existsSync(resolve(root, "packages/camp/instagram-feed/alpha/old.png"))).toBe(true);

    // Request A starts a new run for the same platform and stages one file.
    const a = new FileSystemPackageStore(root, "camp");
    await a.writePackaged("instagram-feed", "alpha/1.png", bytes());

    // Concurrent request B — its own store instance — starts staging the same
    // platform: `ensureStaging`'s stale-staging sweep deletes A's still-live
    // staging dir (it only matches on the `<platform>.staging-` prefix, not
    // on who owns it).
    const b = new FileSystemPackageStore(root, "camp");
    await b.writePackaged("instagram-feed", "beta/1.png", bytes());

    // A's next write would otherwise recreate the missing staging tree via
    // `mkdir(dirname(target), { recursive: true })` and silently resume,
    // committing a manifest that lists a file (alpha/1.png) that no longer
    // exists on disk. It must fail loudly instead.
    await expect(a.writePackaged("instagram-feed", "alpha/2.png", bytes())).rejects.toThrow(
      /export/i,
    );
    // The same store keeps refusing rather than quietly starting over —
    // starting a fresh staging dir here could stomp on B's still-live one.
    await expect(a.writeManifest("instagram-feed", manifest())).rejects.toThrow(
      /export/i,
    );

    // A never reached `rm(finalDir)` + `rename`: the prior commit stands.
    expect(existsSync(resolve(root, "packages/camp/instagram-feed/alpha/old.png"))).toBe(true);
  });

  test("writeManifest refuses to commit when a file its manifest claims is missing from staging, and the previous commit survives byte-for-byte", async () => {
    // A prior, legitimate package run for this platform already committed.
    const prior = new FileSystemPackageStore(root, "camp");
    await prior.writePackaged("instagram-feed", "alpha/old.png", bytes());
    await prior.writeManifest(
      "instagram-feed",
      manifest({ items: [item({ packagedPath: "packages/camp/instagram-feed/alpha/old.png" })] }),
    );
    const priorBytes = readFileSync(resolve(root, "packages/camp/instagram-feed/alpha/old.png"));

    const a = new FileSystemPackageStore(root, "camp");
    await a.writePackaged("instagram-feed", "alpha/1.png", bytes());

    // `assertStagingIntact` only proves the staging directory itself still
    // exists — a narrower sweep can land right after that check (and before
    // the write it guards) and remove just the file a manifest is about to
    // claim, without disturbing the directory. Simulate that exact gap
    // directly: the staging dir stands, but the file it once held is gone.
    const stagingName = readdirSync(resolve(root, "packages/camp")).find((name) =>
      name.startsWith("instagram-feed.staging-"),
    );
    rmSync(resolve(root, "packages/camp", stagingName!, "alpha/1.png"));

    await expect(
      a.writeManifest(
        "instagram-feed",
        manifest({ items: [item({ packagedPath: "packages/camp/instagram-feed/alpha/1.png" })] }),
      ),
    ).rejects.toThrow(/export/i);

    // A never reached `rm(finalDir)` + `rename`: the prior commit's bytes
    // are exactly what they were before A's aborted attempt.
    expect(
      readFileSync(resolve(root, "packages/camp/instagram-feed/alpha/old.png")).equals(priorBytes),
    ).toBe(true);
  });

  test("writeManifest refuses a manifest item whose packagedPath does not belong to this platform's staging dir", async () => {
    const a = new FileSystemPackageStore(root, "camp");
    await a.writePackaged("instagram-feed", "alpha/1.png", bytes());
    await expect(
      a.writeManifest(
        "instagram-feed",
        // A path rooted at a different platform can never be staged here —
        // refuse it the same way a genuinely missing file is refused.
        manifest({ items: [item({ packagedPath: "packages/camp/linkedin/alpha/1.png" })] }),
      ),
    ).rejects.toThrow(/export/i);
  });

  test("writeManifest commits when every manifest-claimed file, including a poster and a fallback path, is present in staging", async () => {
    await store.writePackaged("instagram-feed", "alpha/1.png", bytes());
    await store.writePackaged("instagram-feed", "alpha/1-poster.png", bytes());
    await store.writePackaged("instagram-feed", "alpha/1-fallback.png", bytes());
    const path = await store.writeManifest(
      "instagram-feed",
      manifest({
        items: [
          item({
            format: "motion",
            packagedPath: "packages/camp/instagram-feed/alpha/1.png",
            posterPath: "packages/camp/instagram-feed/alpha/1-poster.png",
            fallbackPath: "packages/camp/instagram-feed/alpha/1-fallback.png",
          }),
        ],
      }),
    );
    expect(existsSync(resolve(root, path))).toBe(true);
    expect(existsSync(resolve(root, "packages/camp/instagram-feed/alpha/1-poster.png"))).toBe(true);
  });
});
