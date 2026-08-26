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
  over: Partial<{
    campaignId: string;
    assets: GeneratedAsset[];
    platforms: string[];
    packagedAt: string;
    skipped: number;
    include: string[];
    capabilities: { motion: boolean };
  }> = {},
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

  test("rejects a motion platform by name (tiktok) without the motion capability", async () => {
    const store = fakeStore();
    const result = await exec(store, { platforms: ["instagram-feed", "tiktok"] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toBe('Platform "tiktok" is not visible');
    expect(store.writePackaged).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("static items carry format: static", async () => {
    const store = fakeStore();
    const result = await exec(store);
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.platforms[0].items[0].format).toBe("static");
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
    expect(feed.included).toBe(2);
    expect(feed.excluded).toBe(0);
    expect(store.manifests[0].manifest.packagedAt).toBe(PACKAGED_AT);
    expect(store.manifests[0].manifest.included).toBe(2);
    expect(store.manifests[0].manifest.excluded).toBe(0);
  });

  test("packages only the included identities (classic triple and variation product/v<index>)", async () => {
    const store = fakeStore();
    const assets = [
      asset({ productId: "alpha", outputPath: "alpha/1x1.png" }),
      asset({ productId: "beta", outputPath: "beta/1x1.png" }),
      asset({ productId: "gamma", outputPath: "gamma/v2.png", variantIndex: 2, treatment: "headline-top-bold" }),
      asset({ productId: "gamma", outputPath: "gamma/v3.png", variantIndex: 3, treatment: "headline-top-bold" }),
      asset({ productId: "alpha", aspectRatio: "16:9", outputPath: "alpha/16x9.png" }),
    ];
    const result = await exec(store, {
      assets,
      platforms: ["instagram-feed", "x"],
      include: ["alpha/1:1/default", "gamma/v3", "nobody/1:1/default"],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [feed, x] = result.value.platforms;
    expect(feed.items.map((i) => i.source)).toEqual(["alpha/1x1.png", "gamma/v3.png"]);
    expect(feed.included).toBe(2);
    expect(feed.excluded).toBe(2);
    expect(x.items).toEqual([]);
    expect(x.included).toBe(0);
    expect(x.excluded).toBe(1);
    expect(store.reads).not.toContain("beta/1x1.png");
    expect(store.manifests[0].manifest.included).toBe(2);
    expect(store.manifests[0].manifest.excluded).toBe(2);
  });

  test("an empty include list packages nothing but still writes the manifest", async () => {
    const store = fakeStore();
    const result = await exec(store, { include: [] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.platforms[0].items).toEqual([]);
    expect(result.value.platforms[0].excluded).toBe(1);
    expect(store.readAsset).not.toHaveBeenCalled();
    expect(store.writeManifest).toHaveBeenCalledTimes(1);
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

describe("PackageForPlatformUseCase — motion", () => {
  const motion = (over: Partial<GeneratedAsset> = {}): GeneratedAsset =>
    asset({
      productId: "alpha",
      aspectRatio: "9:16",
      outputPath: "alpha/9x16/v1.png",
      videoPath: "alpha/9x16/v1.mp4",
      durationSec: 6,
      format: "motion",
      variantIndex: 1,
      treatment: "headline-top-bold",
      ...over,
    });
  const MOTION = { motion: true };

  test("a motion profile packages the mp4 and its poster with format, duration, and checks", async () => {
    const store = fakeStore();
    const assets = [motion(), asset({ aspectRatio: "9:16", outputPath: "alpha/9x16/v2.png", format: "static", variantIndex: 2 })];
    const result = await exec(store, { assets, platforms: ["instagram-reel"], capabilities: MOTION });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [reel] = result.value.platforms;
    expect(reel.items).toEqual([
      {
        productId: "alpha",
        aspectRatio: "9:16",
        treatment: "headline-top-bold",
        format: "motion",
        source: "alpha/9x16/v1.mp4",
        packagedPath: "packages/camp/instagram-reel/alpha/9x16/v1.mp4",
        posterPath: "packages/camp/instagram-reel/alpha/9x16/v1.png",
        durationSec: 6,
        bytes: SMALL.length,
        checks: { size: "pass", duration: "pass" },
      },
    ]);
    // The static 9:16 row is not eligible for a motion profile.
    expect(reel.excluded).toBe(0);
    expect(store.reads).toEqual(["alpha/9x16/v1.mp4", "alpha/9x16/v1.png"]);
  });

  test("a static profile ignores motion rows even at the same ratio", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [motion({ aspectRatio: "1:1" }), asset()],
      platforms: ["instagram-feed"],
      capabilities: MOTION,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.platforms[0].items.map((i) => i.source)).toEqual(["alpha/1x1.png"]);
    expect(result.value.platforms[0].excluded).toBe(0);
  });

  test("a motion row without a videoPath is treated as a static row", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [motion({ videoPath: undefined })],
      platforms: ["instagram-reel"],
      capabilities: MOTION,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.platforms[0].items).toEqual([]);
  });

  test("fails the duration check over the cap or when the row has no duration", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [motion({ durationSec: 61 }), motion({ variantIndex: 3, outputPath: "alpha/9x16/v3.png", videoPath: "alpha/9x16/v3.mp4", durationSec: undefined })],
      platforms: ["instagram-story"],
      capabilities: MOTION,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [over, missing] = result.value.platforms[0].items;
    expect(over.checks.duration).toBe("fail");
    expect(missing.checks.duration).toBe("fail");
    expect(missing).not.toHaveProperty("durationSec");
  });

  test("records a size fail on an oversized mp4", async () => {
    const store = fakeStore(new Uint8Array(platformProfile("tiktok")!.maxBytes + 1));
    const result = await exec(store, { assets: [motion()], platforms: ["tiktok"], capabilities: MOTION });
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.platforms[0].items[0].checks).toEqual({ size: "fail", duration: "pass" });
  });

  test("honours include for motion identities", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [motion(), motion({ variantIndex: 2, outputPath: "alpha/9x16/v2.png", videoPath: "alpha/9x16/v2.mp4" })],
      platforms: ["youtube-short"],
      include: ["alpha/v2"],
      capabilities: MOTION,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.platforms[0].items.map((i) => i.source)).toEqual(["alpha/9x16/v2.mp4"]);
    expect(result.value.platforms[0].excluded).toBe(1);
  });
});
