import { describe, test, expect, vi } from "vitest";
import type { GeneratedAsset } from "@campaignfoundry/CampaignOrchestration";
import { PackageForPlatformUseCase, withoutAbsolutePaths } from "../PackageForPlatformUseCase.use-case.js";
import type { PackageManifest, PackageStorePort } from "../../ports/out/PackageStorePort.js";
import { platformProfile } from "../../../domain/value-objects/PlatformProfile.vo.js";

const PACKAGED_AT = "2026-08-25T12:00:00.000Z";

const asset = (over: Partial<GeneratedAsset> = {}): GeneratedAsset => ({
  productId: "alpha",
  aspectRatio: "1:1",
  outputPath: "alpha/1x1.png",
  complianceScore: 0.5,
  passedCompliance: true,
  logoApplied: true,
  treatment: "default",
  backgroundSource: "procedural",
  ...over,
});

const SMALL = new Uint8Array([1, 2, 3]);

const fakeStore = (read: Uint8Array = SMALL): PackageStorePort & {
  reads: string[];
  packaged: Array<{ platformId: string; relativePath: string; bytes: Uint8Array }>;
  manifests: Array<{ platformId: string; manifest: PackageManifest }>;
} => {
  const reads: string[] = [];
  const packaged: Array<{ platformId: string; relativePath: string; bytes: Uint8Array }> = [];
  const manifests: Array<{ platformId: string; manifest: PackageManifest }> = [];
  return {
    reads,
    packaged,
    manifests,
    readAsset: vi.fn(async (relativePath: string) => {
      reads.push(relativePath);
      return read;
    }),
    writePackaged: vi.fn(async (platformId: string, relativePath: string, bytes: Uint8Array) => {
      packaged.push({ platformId, relativePath, bytes });
      return `packages/camp/${platformId}/${relativePath}`;
    }),
    writeManifest: vi.fn(async (platformId: string, manifest: PackageManifest) => {
      manifests.push({ platformId, manifest });
      return `packages/camp/${platformId}/manifest.json`;
    }),
  };
};

const exec = (
  store: PackageStorePort,
  over: Partial<{ campaignId: string; assets: GeneratedAsset[]; platforms: string[]; packagedAt: string; skipped: number }> = {},
) =>
  new PackageForPlatformUseCase(store).execute({
    campaignId: "camp",
    assets: [asset()],
    platforms: ["instagram-feed"],
    packagedAt: PACKAGED_AT,
    ...over,
  });

describe("withoutAbsolutePaths", () => {
  test("strips POSIX and Windows absolute paths, quoted or bare", () => {
    expect(withoutAbsolutePaths("ENOENT: no such file or directory, open '/var/data/alpha/1x1.png'")).toBe(
      "ENOENT: no such file or directory, open '<path>'",
    );
    expect(withoutAbsolutePaths("open C:\\output\\alpha\\1x1.png")).toBe("open <path>");
    expect(withoutAbsolutePaths("relative/path.png stayed")).toBe("relative/path.png stayed");
    expect(withoutAbsolutePaths("/tmp/alone.png")).toBe("<path>");
  });
});

describe("PackageForPlatformUseCase", () => {
  test("rejects an unknown platform id before touching the store", async () => {
    const store = fakeStore();
    const result = await exec(store, { platforms: ["myspace"] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toBe('Unknown platform "myspace"');
    expect(store.readAsset).not.toHaveBeenCalled();
    expect(store.writePackaged).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("rejects a hidden platform by name (tiktok) without writing", async () => {
    const store = fakeStore();
    const result = await exec(store, { platforms: ["instagram-feed", "tiktok"] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/tiktok/);
    expect(store.writePackaged).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("selects 1:1 assets for instagram-feed and 16:9 for x; 9:16 is not selected", async () => {
    const store = fakeStore();
    const assets = [
      asset({ productId: "alpha", aspectRatio: "1:1", outputPath: "alpha/1x1.png" }),
      asset({ productId: "beta", aspectRatio: "1:1", outputPath: "beta/1x1.png" }),
      asset({ productId: "alpha", aspectRatio: "16:9", outputPath: "alpha/16x9.png" }),
      asset({ productId: "alpha", aspectRatio: "9:16", outputPath: "alpha/9x16.png" }),
    ];
    const result = await exec(store, { assets, platforms: ["instagram-feed", "x"] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [feed, x] = result.value.platforms;
    expect(feed.items.map((i) => i.source)).toEqual(["alpha/1x1.png", "beta/1x1.png"]);
    expect(x.items.map((i) => i.source)).toEqual(["alpha/16x9.png"]);
    expect(store.reads).not.toContain("alpha/9x16.png");
    expect(feed.items.every((i) => i.checks.size === "pass")).toBe(true);
    expect(x.items.every((i) => i.checks.size === "pass")).toBe(true);
    expect(feed.skipped).toBe(0);
    expect(store.manifests[0].manifest.packagedAt).toBe(PACKAGED_AT);
  });

  test("records a size fail but still writes the packaged file", async () => {
    const cap = platformProfile("instagram-feed")!.maxBytes;
    const oversized = new Uint8Array(cap + 1);
    const store = fakeStore(oversized);
    const result = await exec(store);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.platforms[0].items[0].checks.size).toBe("fail");
    expect(result.value.platforms[0].items[0].bytes).toBe(oversized.length);
    expect(store.writePackaged).toHaveBeenCalledTimes(1);
    expect(store.writeManifest).toHaveBeenCalledTimes(1);
  });

  test("writes an empty-items manifest when no asset matches the platform ratio", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [asset({ aspectRatio: "16:9", outputPath: "alpha/16x9.png" })],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.platforms[0].items).toEqual([]);
    expect(result.value.platforms[0].manifestPath).toBe("packages/camp/instagram-feed/manifest.json");
    expect(store.writeManifest).toHaveBeenCalledTimes(1);
    expect(store.manifests[0].manifest.profile.id).toBe("instagram-feed");
    expect(store.manifests[0].manifest.skipped).toBe(0);
    expect(store.readAsset).not.toHaveBeenCalled();
  });

  test("copies a skipped count onto every platform manifest", async () => {
    const store = fakeStore();
    const result = await exec(store, { skipped: 2, platforms: ["instagram-feed", "linkedin"] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.platforms.map((p) => p.skipped)).toEqual([2, 2]);
    expect(store.manifests.every((m) => m.manifest.skipped === 2)).toBe(true);
  });

  test("returns Platform id: reason when readAsset rejects, without leaking absolute paths", async () => {
    const store = fakeStore();
    store.readAsset = vi.fn(async () => {
      throw new Error("ENOENT: no such file or directory, open '/var/data/output/alpha/1x1.png'");
    });
    const result = await exec(store);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Platform "instagram-feed": ENOENT: no such file or directory, open \'<path>\'',
      );
      expect(result.error.message).not.toMatch(/\/var\//);
    }
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("returns Platform id: reason when writePackaged rejects, sanitizing a non-Error throw", async () => {
    const store = fakeStore();
    store.writePackaged = vi.fn(async () => {
      throw "disk full at /mnt/data/packages";
    });
    const result = await exec(store);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe('Platform "instagram-feed": disk full at <path>');
    }
  });

  test("keeps an earlier platform's writes when a later platform's store call fails", async () => {
    const store = fakeStore();
    store.readAsset = vi.fn(async (relativePath: string) => {
      if (relativePath.includes("16x9")) throw new Error("ENOENT: open '/abs/missing.png'");
      return SMALL;
    });
    const result = await exec(store, {
      assets: [asset(), asset({ aspectRatio: "16:9", outputPath: "alpha/16x9.png" })],
      platforms: ["instagram-feed", "x"],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/^Platform "x":/);
    expect(store.writeManifest).toHaveBeenCalledTimes(1);
    expect(store.manifests[0].platformId).toBe("instagram-feed");
  });
});
