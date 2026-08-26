import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileSystemPackageStore } from "../FileSystemPackageStore.js";
import type { PackageManifest } from "../../../application/ports/out/PackageStorePort.js";
import { platformProfile } from "../../../domain/value-objects/PlatformProfile.vo.js";

const bytes = (): Uint8Array => new Uint8Array([137, 80, 78, 71]);

const manifest = (): PackageManifest => ({
  campaignId: "camp",
  platformId: "instagram-feed",
  profile: platformProfile("instagram-feed")!,
  items: [],
});

describe("FileSystemPackageStore", () => {
  let root: string;
  let store: FileSystemPackageStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cf-package-"));
    store = new FileSystemPackageStore(root, "camp");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

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

  test("writePackaged lands under platforms/<id>/ and returns an output-relative path", async () => {
    const written = bytes();
    const path = await store.writePackaged("instagram-feed", "alpha/1x1.png", written);
    expect(path).toBe("camp/platforms/instagram-feed/alpha/1x1.png");
    const onDisk = readFileSync(resolve(root, path));
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

  test("writePackaged refuses a campaign id that escapes via ..", async () => {
    const escaped = new FileSystemPackageStore(root, "..");
    await expect(escaped.writePackaged("instagram-feed", "x.png", bytes())).rejects.toThrow(
      /Refusing to write outside the output root/,
    );
  });

  test("writeManifest writes JSON under platforms/<id>/manifest.json", async () => {
    const path = await store.writeManifest("instagram-feed", manifest());
    expect(path).toBe("camp/platforms/instagram-feed/manifest.json");
    const parsed = JSON.parse(readFileSync(resolve(root, path), "utf8")) as PackageManifest;
    expect(parsed.platformId).toBe("instagram-feed");
    expect(parsed.items).toEqual([]);
  });

  test("writeManifest refuses a platform id that escapes via ..", async () => {
    await expect(store.writeManifest("..", manifest())).rejects.toThrow(
      /Refusing to write outside the output root/,
    );
  });
});
