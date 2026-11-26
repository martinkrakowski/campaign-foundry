import { describe, test, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import type { GeneratedAsset } from "@campaignfoundry/CampaignOrchestration";
import {
  BRIEF_SCHEMA_VERSION,
  CANONICAL_TEMPLATES,
  DEFAULT_CAMPAIGN_TYPE,
  GenerateCampaignUseCase,
  PublishAdClipUseCase,
  templateFromCanonical,
  type BriefTemplate,
  type CampaignBrief,
  type CompositeRequest,
  type GenerateCampaignDeps,
  type ObjectKey,
  type Product,
  type VideoCompositorPort,
  PUBLISH_PLACEHOLDER_URL_PREFIX,
} from "@campaignfoundry/CampaignOrchestration";
import { InMemoryObjectStore } from "@campaignfoundry/CampaignOrchestration/infrastructure";
import type { DisplaySize } from "@campaignfoundry/CampaignOrchestration/display-sizes";
import {
  fakeAudioAssets,
  fakeCompliance,
  fakeCompositor,
  fakeImageGenerator,
  fakePlan,
  fakePlanner,
  fakePublicAdMedia,
  fakePublishedClipRecord,
  fakeSceneAssets,
  fakeVariant,
  fakeVideoCompositor,
  recordingExporter,
} from "../../../../../CampaignOrchestration/src/application/use-cases/__tests__/_fakes.js";
import {
  PackageForPlatformUseCase,
  withoutAbsolutePaths,
} from "../PackageForPlatformUseCase.use-case.js";
import { ObjectPackageStore } from "../../../infrastructure/adapters/ObjectPackageStore.js";
import { renderObjectKey } from "../../../infrastructure/adapters/ObjectExporter.js";
import type { PackageManifest, PackageStorePort } from "../../ports/out/PackageStorePort.js";
import {
  platformProfile,
  type PlatformProfile,
} from "../../../domain/value-objects/PlatformProfile.vo.js";

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

const fakeStore = (
  read: Uint8Array = SMALL,
): PackageStorePort & {
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
    clickDestination?: string;
    publishClip?: boolean;
    clipPublisher?: (selector: string) => Promise<string>;
    /**
     * Profile lookup override for platforms `platformProfile` does not know —
     * how a test registers a profile that declares `html` (none ships one yet,
     * D122). Unknown ids fall through to the real table.
     */
    profiles: Record<string, PlatformProfile>;
  }> = {},
) => {
  const { profiles, ...input } = over;
  return new PackageForPlatformUseCase(
    store,
    (id) => profiles?.[id] ?? platformProfile(id),
  ).execute({
    campaignId: "camp",
    assets: [asset()],
    platforms: ["instagram-feed"],
    packagedAt: PACKAGED_AT,
    ...input,
  });
};

describe("withoutAbsolutePaths", () => {
  test("strips POSIX and Windows absolute paths, quoted or bare", () => {
    expect(
      withoutAbsolutePaths("ENOENT: no such file or directory, open '/var/data/alpha/1x1.png'"),
    ).toBe("ENOENT: no such file or directory, open '<path>'");
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
      asset({
        productId: "gamma",
        outputPath: "gamma/v2.png",
        variantIndex: 2,
        treatment: "headline-top-bold",
      }),
      asset({
        productId: "gamma",
        outputPath: "gamma/v3.png",
        variantIndex: 3,
        treatment: "headline-top-bold",
      }),
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
    expect(result.value.platforms[0].manifestPath).toBe(
      "packages/camp/instagram-feed/manifest.json",
    );
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
        "Platform \"instagram-feed\": ENOENT: no such file or directory, open '<path>'",
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

  test("keeps an earlier platform's writes when a later platform's store write fails", async () => {
    const store = fakeStore();
    // A store WRITE failure is an infrastructure fault, not a refusal: the port
    // has no delete, so earlier platforms' written files stay. (Refusals —
    // unreadable assets among them — are resolved in the prepare phase, before
    // any write, so they leave nothing behind.)
    store.writePackaged = vi.fn(async (platformId: string, relativePath: string) => {
      if (platformId === "x") throw new Error("ENOENT: open '/abs/missing.png'");
      return `packages/camp/${platformId}/${relativePath}`;
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

describe("PackageForPlatformUseCase — display profiles (A4b)", () => {
  /** A display row: size instead of a ratio (D113) — exactly one of the two. */
  const displayAsset = (size: DisplaySize, over: Partial<GeneratedAsset> = {}): GeneratedAsset =>
    asset({ size, aspectRatio: undefined, outputPath: `alpha/${size}.png`, ...over });

  test("matches a display profile's assets by size and packages nothing social", async () => {
    const store = fakeStore();
    const assets = [
      displayAsset("728x90"),
      displayAsset("300x250"),
      asset({ outputPath: "alpha/1x1.png" }),
    ];
    const result = await exec(store, { assets, platforms: ["google-display"] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [display] = result.value.platforms;
    expect(display.items.map((i) => i.source)).toEqual(["alpha/728x90.png", "alpha/300x250.png"]);
    // Manifest items carry the size, not a ratio.
    expect(display.items[0].size).toBe("728x90");
    expect(display.items[0].aspectRatio).toBeUndefined();
    expect(display.items[1].size).toBe("300x250");
    expect(display.included).toBe(2);
    expect(display.excluded).toBe(0);
  });

  test("fails a display platform whose run produced no display assets, instead of an empty manifest", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [asset({ outputPath: "alpha/1x1.png" })],
      platforms: ["google-display"],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Platform "google-display": no display assets for google-display — was the campaign generated with output.sizes?',
      );
    }
    expect(store.readAsset).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("an include that selects nothing for a display platform is refused, not packaged as an empty manifest (X14 fix2)", async () => {
    const store = fakeStore();
    // The rejected-html-approval shape: the row IS eligible for
    // google-display-html (its format and size match), but the approved
    // `include` set selects none of it. Eligibility before `include` let that
    // through the display guard and wrote a successful manifest with
    // `items: []` — the D8 empty package the guard exists to refuse.
    const result = await exec(store, {
      assets: [
        displayAsset("728x90", {
          format: "html",
          htmlBundlePath: "alpha/728x90/index.html",
          htmlFallbackPath: "alpha/728x90/fallback.png",
        }),
      ],
      platforms: ["google-display-html"],
      include: [],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Platform "google-display-html": no display assets for google-display-html — was the campaign generated with output.sizes?',
      );
    }
    expect(store.readAsset).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("packages only the sizes a display profile accepts; an unaccepted size is not an error", async () => {
    const store = fakeStore();
    const assets = [displayAsset("728x90"), displayAsset("300x250")];
    const result = await exec(store, { assets, platforms: ["meta-audience-network"] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.platforms[0].items.map((i) => i.source)).toEqual(["alpha/300x250.png"]);
    // A size the profile does not accept is not eligible at all (not excluded
    // by `include`), and meta-audience-network has other sizes, so no failure.
    expect(result.value.platforms[0].excluded).toBe(0);
    expect(store.reads).not.toContain("alpha/728x90.png");
  });

  test("a size row never matches a social profile and a ratio row never matches a display one", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [displayAsset("728x90"), asset({ outputPath: "alpha/1x1.png" })],
      platforms: ["instagram-feed"],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.platforms[0].items.map((i) => i.source)).toEqual(["alpha/1x1.png"]);
    expect(store.reads).not.toContain("alpha/728x90.png");
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
    const assets = [
      motion(),
      asset({
        aspectRatio: "9:16",
        outputPath: "alpha/9x16/v2.png",
        format: "static",
        variantIndex: 2,
      }),
    ];
    const result = await exec(store, {
      assets,
      platforms: ["instagram-reel"],
      capabilities: MOTION,
    });
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
      assets: [
        motion({ durationSec: 61 }),
        motion({
          variantIndex: 3,
          outputPath: "alpha/9x16/v3.png",
          videoPath: "alpha/9x16/v3.mp4",
          durationSec: undefined,
        }),
      ],
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
    const result = await exec(store, {
      assets: [motion()],
      platforms: ["tiktok"],
      capabilities: MOTION,
    });
    expect(result.success).toBe(true);
    if (result.success)
      expect(result.value.platforms[0].items[0].checks).toEqual({ size: "fail", duration: "pass" });
  });

  test("honours include for motion identities", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [
        motion(),
        motion({
          variantIndex: 2,
          outputPath: "alpha/9x16/v2.png",
          videoPath: "alpha/9x16/v2.mp4",
        }),
      ],
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

describe("PackageForPlatformUseCase — music rights (VE-D8)", () => {
  test("refuses the whole request when an asset's licence expired before packagedAt, naming the asset and licence; nothing is written", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [
        asset({
          audioRights: { licenceId: "lic-1", source: "acme", expiresOn: "2026-08-01" },
        }),
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("lic-1");
      expect(result.error.message).toContain("alpha");
    }
    expect(store.readAsset).not.toHaveBeenCalled();
    expect(store.writePackaged).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("refuses the whole request when two selected rows share an identity, the first expired and the second not (VE3a fix3)", async () => {
    // The route accepts separate persisted rows without enforcing unique
    // identities: both rows below key to the same `alpha/1:1/default`
    // identity. Deduping the expiry check by identity let the second,
    // unexpired row silently replace the first in the check while the
    // packaging loop still wrote both — this must refuse, naming the
    // expired row's licence.
    const store = fakeStore();
    const expired = asset({
      outputPath: "alpha/1x1-v1.png",
      audioRights: { licenceId: "lic-1", source: "acme", expiresOn: "2026-08-01" },
    });
    const replacement = asset({ outputPath: "alpha/1x1-v2.png" });
    const result = await exec(store, { assets: [expired, replacement] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("lic-1");
      expect(result.error.message).toContain("alpha");
    }
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("packages an asset whose licence is valid at packagedAt", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [
        asset({
          audioRights: { licenceId: "lic-1", source: "acme", expiresOn: "2026-08-26" },
        }),
      ],
    });
    expect(result.success).toBe(true);
  });

  test("a licence expiring exactly at packagedAt is still valid (strict <)", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [
        asset({ audioRights: { licenceId: "lic-1", source: "acme", expiresOn: PACKAGED_AT } }),
      ],
    });
    expect(result.success).toBe(true);
  });

  test("an asset without rights packages exactly as today", async () => {
    const store = fakeStore();
    const result = await exec(store, { assets: [asset()] });
    expect(result.success).toBe(true);
  });

  test("expiry is checked only against assets actually selected for the requested platform (fix2 #5)", async () => {
    const store = fakeStore();
    // A 9:16 row is not eligible for instagram-feed (1:1 static) — an expired
    // licence on it must not block a package it plays no part in.
    const result = await exec(store, {
      assets: [
        asset({
          aspectRatio: "9:16",
          outputPath: "alpha/9x16/v1.png",
          audioRights: { licenceId: "lic-1", source: "acme", expiresOn: "2026-08-01" },
        }),
        asset(),
      ],
      platforms: ["instagram-feed"],
    });
    expect(result.success).toBe(true);
  });

  test("expiry is checked only against included assets when `include` drops the rights-bearing row (fix2 #5)", async () => {
    const store = fakeStore();
    const expired = asset({
      productId: "alpha",
      audioRights: { licenceId: "lic-1", source: "acme", expiresOn: "2026-08-01" },
    });
    const clean = asset({ productId: "beta", outputPath: "beta/1x1.png" });
    const result = await exec(store, {
      assets: [expired, clean],
      include: ["beta/1:1/default"],
    });
    expect(result.success).toBe(true);
  });

  test("a malformed packagedAt fails closed with a clear error; nothing is written (fix2 #6)", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [
        asset({ audioRights: { licenceId: "lic-1", source: "acme", expiresOn: "2026-08-01" } }),
      ],
      packagedAt: "not-a-timestamp",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/packagedAt/);
    expect(store.writeManifest).not.toHaveBeenCalled();
  });
});

describe("PackageForPlatformUseCase — html (D122)", () => {
  /** A 1:1 social-shaped profile that declares `html` — no shipped profile does yet; the test registers it. */
  const HTML_PROFILE: PlatformProfile = {
    id: "html-banner",
    label: "HTML Banner",
    ratio: "1:1",
    formats: ["html"],
    safeInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    maxBytes: 8 * 1024 * 1024,
  };
  const html = (over: Partial<GeneratedAsset> = {}): GeneratedAsset =>
    asset({
      productId: "alpha",
      aspectRatio: "1:1",
      outputPath: "alpha/1x1.png",
      format: "html",
      htmlBundlePath: "alpha/1x1/index.html",
      htmlFallbackPath: "alpha/1x1/fallback.png",
      variantIndex: 1,
      ...over,
    });

  test("refuses an html asset without a fallback rendition, naming the field; nothing is written", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [html({ htmlFallbackPath: undefined })],
      platforms: ["html-banner"],
      profiles: { "html-banner": HTML_PROFILE },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('"htmlFallbackPath"');
      expect(result.error.message).toContain("alpha/v1");
    }
    expect(store.writePackaged).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("a profile whose formats include html packages the bundle and its raster fallback, recording format: html", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": HTML_PROFILE },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [banner] = result.value.platforms;
    expect(banner.items).toEqual([
      {
        productId: "alpha",
        aspectRatio: "1:1",
        treatment: "default",
        format: "html",
        source: "alpha/1x1/index.html",
        packagedPath: "packages/camp/html-banner/alpha/1x1/index.html",
        fallbackPath: "packages/camp/html-banner/alpha/1x1/fallback.png",
        bytes: SMALL.length,
        checks: { size: "pass" },
      },
    ]);
    // Both the bundle and its fallback ride along — nothing else is read.
    expect(store.reads).toEqual(["alpha/1x1/index.html", "alpha/1x1/fallback.png"]);
    expect(store.manifests[0].manifest.items[0].format).toBe("html");
  });

  test("a profile that does not declare html skips an html asset, exactly as a static profile skips motion", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [html(), html({ variantIndex: 2, htmlBundlePath: "alpha/1x1/v2/index.html" })],
      platforms: ["instagram-feed"],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.platforms[0].items).toEqual([]);
    expect(result.value.platforms[0].included).toBe(0);
    expect(store.reads).toEqual([]);
  });

  test("records no pixel hash for an html asset — markup is verified structurally, never rasterised (D122/D125)", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": HTML_PROFILE },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const item = result.value.platforms[0].items[0];
    expect(JSON.stringify(item)).not.toContain("hash");
    expect(item.checks).toEqual({ size: "pass" });
  });

  test("an html bundle over the profile cap records a size fail but is still packaged", async () => {
    const store = fakeStore(new Uint8Array(HTML_PROFILE.maxBytes + 1));
    const result = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": HTML_PROFILE },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.platforms[0].items[0].checks).toEqual({ size: "fail" });
  });

  test("the budget counts the whole unit — bundle plus fallback — not the bundle alone (X14)", async () => {
    // The shipped unit is index.html AND fallback.png; a network measures the
    // uploaded package. Here the bundle fits the profile's budget on its own and
    // the fallback is what crosses it, so the only honest verdict is a fail.
    const maxBytes = 1024;
    const profile: PlatformProfile = { ...HTML_PROFILE, maxBytes };
    const bundle = new Uint8Array(maxBytes - 8);
    const fallback = new Uint8Array(16);
    const store = fakeStore();
    const bytesFor: Record<string, Uint8Array> = {
      "alpha/1x1/index.html": bundle,
      "alpha/1x1/fallback.png": fallback,
    };
    vi.mocked(store.readAsset).mockImplementation(
      async (relativePath: string) => bytesFor[relativePath],
    );
    const result = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": profile },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const item = result.value.platforms[0].items[0];
    expect(item.checks).toEqual({ size: "fail" });
    // Both files were still written — a fail is recorded, not a refusal.
    expect(store.packaged.map((p) => p.relativePath)).toEqual([
      "alpha/1x1/index.html",
      "alpha/1x1/fallback.png",
    ]);
  });

  test("a unit whose bundle and fallback together fit the budget records a size pass (X14)", async () => {
    const maxBytes = 1024;
    const profile: PlatformProfile = { ...HTML_PROFILE, maxBytes };
    const store = fakeStore();
    const bytesFor: Record<string, Uint8Array> = {
      "alpha/1x1/index.html": new Uint8Array(maxBytes - 8),
      "alpha/1x1/fallback.png": new Uint8Array(8),
    };
    vi.mocked(store.readAsset).mockImplementation(
      async (relativePath: string) => bytesFor[relativePath],
    );
    const result = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": profile },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.platforms[0].items[0].checks).toEqual({ size: "pass" });
  });

  test("refuses an html asset when clickDestination is set on brief/asset but bundle lacks clickTag variable (HL4)", async () => {
    // A bundle that contains no clickTag variable (e.g. bare html or an <a href>)
    const bundleWithoutClickTag = new TextEncoder().encode(
      '<!DOCTYPE html><html><body><a href="https://example.com">Click</a></body></html>',
    );
    const store = fakeStore(bundleWithoutClickTag);
    const result = await exec(store, {
      assets: [html({ clickDestination: "https://example.com/landing" })],
      platforms: ["html-banner"],
      profiles: { "html-banner": HTML_PROFILE },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("clickTag");
      expect(result.error.message).toContain("alpha/v1");
    }
    expect(store.writePackaged).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("refuses an html asset when clickDestination is set at input level but bundle lacks clickTag (HL4)", async () => {
    const bundleWithoutClickTag = new TextEncoder().encode(
      "<!DOCTYPE html><html><body>Hello</body></html>",
    );
    const store = fakeStore(bundleWithoutClickTag);
    const result = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": HTML_PROFILE },
      clickDestination: "https://example.com/landing",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("clickTag");
      expect(result.error.message).toContain("alpha/v1");
    }
  });

  test("packages an html asset when clickDestination is set and bundle declares var clickTag (HL4)", async () => {
    const bundleWithClickTag = new TextEncoder().encode(
      '<!DOCTYPE html><html><head><script>var clickTag = "https://example.com/landing";</script></head><body><button onclick="window.open(window.clickTag)">Click</button></body></html>',
    );
    const store = fakeStore(bundleWithClickTag);
    const result = await exec(store, {
      assets: [html({ clickDestination: "https://example.com/landing" })],
      platforms: ["html-banner"],
      profiles: { "html-banner": HTML_PROFILE },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.platforms[0].items[0].format).toBe("html");
    expect(store.writePackaged).toHaveBeenCalled();
  });
});

describe("PackageForPlatformUseCase — shipped html5 display profiles (X14)", () => {
  /** An `image-html` display row: a size, not a ratio (D113), plus the unit's two files. */
  const htmlDisplay = (size: DisplaySize, over: Partial<GeneratedAsset> = {}): GeneratedAsset =>
    asset({
      size,
      aspectRatio: undefined,
      outputPath: `alpha/${size}/fallback.png`,
      treatment: "image-html",
      format: "html",
      htmlBundlePath: `alpha/${size}/index.html`,
      htmlFallbackPath: `alpha/${size}/fallback.png`,
      variantIndex: 1,
      ...over,
    });

  test("packages an image-html asset for google-display-html: index.html and fallback written, format html on the item", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [htmlDisplay("300x250")],
      platforms: ["google-display-html"],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [platform] = result.value.platforms;
    expect(platform.included).toBe(1);
    expect(store.reads).toEqual(["alpha/300x250/index.html", "alpha/300x250/fallback.png"]);
    expect(store.packaged.map((p) => `${p.platformId}/${p.relativePath}`)).toEqual([
      "google-display-html/alpha/300x250/index.html",
      "google-display-html/alpha/300x250/fallback.png",
    ]);
    expect(platform.items[0].format).toBe("html");
    expect(platform.items[0].size).toBe("300x250");
    expect(platform.items[0].checks).toEqual({ size: "pass" });
    expect(store.manifests[0].manifest.profile.maxBytes).toBe(150 * 1024);
  });

  test("a static display profile packages an html row's raster fallback, and a static row too", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [
        htmlDisplay("300x250"),
        asset({
          size: "300x250",
          aspectRatio: undefined,
          outputPath: "alpha/300x250.png",
          treatment: "image-html",
        }),
      ],
      platforms: ["google-display"],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.platforms[0].items.map((i) => i.source)).toEqual([
      "alpha/300x250/fallback.png",
      "alpha/300x250.png",
    ]);
    expect(result.value.platforms[0].items.every((item) => item.format === "static")).toBe(true);
    expect(store.reads).toEqual(["alpha/300x250/fallback.png", "alpha/300x250.png"]);
  });

  test("google-display packages the fallback when the run produced only html rows", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [htmlDisplay("300x250"), htmlDisplay("728x90")],
      platforms: ["google-display"],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.platforms[0].items.map((item) => item.format)).toEqual([
      "static",
      "static",
    ]);
    expect(result.value.platforms[0].items.map((item) => item.source)).toEqual([
      "alpha/300x250/fallback.png",
      "alpha/728x90/fallback.png",
    ]);
  });

  test("display-web-html packages an image-html asset too, and no other size reaches the unit", async () => {
    const store = fakeStore();
    const result = await exec(store, {
      assets: [htmlDisplay("160x600"), htmlDisplay("300x250", { productId: "beta" })],
      platforms: ["display-web-html"],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [platform] = result.value.platforms;
    expect(platform.included).toBe(2);
    expect(platform.items.map((i) => i.source)).toEqual([
      "alpha/160x600/index.html",
      "alpha/300x250/index.html",
    ]);
    expect(platform.items.every((i) => i.format === "html")).toBe(true);
  });
});

describe("PackageForPlatformUseCase — clip placeholder publishing (CFAR6C3)", () => {
  const HTML_MAX_BYTES = 150 * 1024;
  const CLIP_PROFILE: PlatformProfile = {
    id: "html-banner",
    label: "HTML Banner",
    ratio: "1:1",
    formats: ["html"],
    safeInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    maxBytes: HTML_MAX_BYTES,
  };
  const html = (over: Partial<GeneratedAsset> = {}): GeneratedAsset =>
    asset({
      productId: "alpha",
      aspectRatio: "1:1",
      outputPath: "alpha/1x1.png",
      format: "html",
      htmlBundlePath: "alpha/1x1/index.html",
      htmlFallbackPath: "alpha/1x1/fallback.png",
      variantIndex: 1,
      ...over,
    });
  const BUNDLE_PATH = "alpha/1x1/index.html";
  const FALLBACK_PATH = "alpha/1x1/fallback.png";
  const FALLBACK = new Uint8Array(8);
  const urlFor = (selector: string): string => `https://media.test/${selector}`;

  /** A store serving the given bundle for the html path and a small fallback. */
  const htmlStore = (bundle: Uint8Array, fallback: Uint8Array = FALLBACK) => {
    const store = fakeStore();
    const bytesFor: Record<string, Uint8Array> = {
      [BUNDLE_PATH]: bundle,
      [FALLBACK_PATH]: fallback,
    };
    vi.mocked(store.readAsset).mockImplementation(
      async (relativePath: string) => bytesFor[relativePath]!,
    );
    return store;
  };

  /** A bundle whose body carries each selector's placeholder `src` once. */
  const bundleWith = (repeat: number, ...selectors: string[]): Uint8Array =>
    new TextEncoder().encode(
      `<!DOCTYPE html><html><body>${selectors
        .map((selector) =>
          `<video src="${PUBLISH_PLACEHOLDER_URL_PREFIX}${selector}"></video>`.repeat(repeat),
        )
        .join("")}</body></html>`,
    );

  const publisher = vi.fn(async (selector: string) => urlFor(selector));

  beforeEach(() => {
    publisher.mockClear();
  });

  test("brief-authored text carrying the placeholder prefix publishes nothing extra (CFAR6 fix2)", async () => {
    // The bundle is the assembler's own output: the real video src placeholder,
    // plus a headline, an alt and a clickTag declaration whose text carries
    // the prefix. The finder scans ONLY the emitted video src — so only the
    // real selector is published, and the text tokens are substituted nowhere.
    const evil = `${PUBLISH_PLACEHOLDER_URL_PREFIX}evil/1x1/v9.mp4`;
    const bundle = new TextEncoder().encode(
      `<!DOCTYPE html><html><head><script>var clickTag = "https://example.com/?u=${evil}";</script></head>` +
        `<body><img src="fallback.png" alt="${evil}" />` +
        `<span>Shop ${evil}</span>` +
        `<video src="${PUBLISH_PLACEHOLDER_URL_PREFIX}alpha/1x1/v0.mp4" muted autoplay playsinline poster="fallback.png"></video></body></html>`,
    );
    const store = htmlStore(bundle);
    const result = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": CLIP_PROFILE },
      publishClip: true,
      clipPublisher: publisher,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Only the slot's own clip was published — never the prefix in the text.
    expect(publisher).toHaveBeenCalledTimes(1);
    expect(publisher).toHaveBeenCalledWith("alpha/1x1/v0.mp4");
    const written = store.packaged.find((p) => p.relativePath === BUNDLE_PATH)!;
    const htmlText = new TextDecoder().decode(written.bytes);
    // The real token is substituted; the brief-authored text tokens survive as text.
    expect(htmlText).toContain(urlFor("alpha/1x1/v0.mp4"));
    expect(htmlText).toContain(evil);
    expect(htmlText).not.toContain(`${PUBLISH_PLACEHOLDER_URL_PREFIX}alpha/1x1/v0.mp4`);
  });

  test("publishClip false refuses a bundle that still carries placeholders, before any write", async () => {
    const store = htmlStore(bundleWith(1, "alpha/1x1/v0.mp4"));
    const result = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": CLIP_PROFILE },
      clipPublisher: publisher,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Platform "html-banner": HTML asset alpha/v1 carries video clip placeholders but "publishClip" is not enabled — packaging would ship unresolvable placeholder URLs.',
      );
    }
    expect(publisher).not.toHaveBeenCalled();
    expect(store.writePackaged).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("a bundle without placeholders packages normally with the flag false, and the publisher is never called", async () => {
    const store = htmlStore(
      new TextEncoder().encode("<!DOCTYPE html><html><body>still</body></html>"),
    );
    const result = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": CLIP_PROFILE },
      publishClip: false,
      clipPublisher: publisher,
    });
    expect(result.success).toBe(true);
    expect(publisher).not.toHaveBeenCalled();
    expect(store.packaged.map((p) => p.relativePath)).toEqual([BUNDLE_PATH, FALLBACK_PATH]);
  });

  test("publishClip true without a clip publisher refuses with zero writes", async () => {
    const store = htmlStore(bundleWith(1, "alpha/1x1/v0.mp4"));
    const result = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": CLIP_PROFILE },
      publishClip: true,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Platform "html-banner": "publishClip" is enabled but no clip publisher was provided.',
      );
    }
    expect(store.writePackaged).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("substitutes each distinct placeholder's published URL once, unescaped, with zero placeholders left", async () => {
    const bundle = bundleWith(2, "alpha/1x1/v0.mp4", "alpha/9x16/v1.mp4");
    const store = htmlStore(bundle);
    const result = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": CLIP_PROFILE },
      publishClip: true,
      clipPublisher: publisher,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // One publish per DISTINCT selector, despite the token appearing twice.
    expect(publisher).toHaveBeenCalledTimes(2);
    expect(publisher).toHaveBeenNthCalledWith(1, "alpha/1x1/v0.mp4");
    expect(publisher).toHaveBeenNthCalledWith(2, "alpha/9x16/v1.mp4");

    const written = store.packaged.find((p) => p.relativePath === BUNDLE_PATH)!;
    const htmlText = new TextDecoder().decode(written.bytes);
    expect(htmlText).toContain(urlFor("alpha/1x1/v0.mp4"));
    expect(htmlText).toContain(urlFor("alpha/9x16/v1.mp4"));
    expect(htmlText).not.toContain("publish.invalid");

    const item = result.value.platforms[0].items[0];
    expect(item.bytes).toBe(written.bytes.length);
    // The substituted unit fits the 150 KiB cap the shipped profiles declare.
    expect(item.checks).toEqual({ size: "pass" });
  });

  test("the size check re-measures the SUBSTITUTED bundle, recording fail but still packaging (HTML_MAX_BYTES)", async () => {
    // The stored bundle is small; the published URLs are what push the unit over.
    const bundle = bundleWith(1, "alpha/1x1/v0.mp4");
    const longUrl = `https://media.test/${"a".repeat(HTML_MAX_BYTES)}`;
    const store = htmlStore(bundle);
    const result = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": CLIP_PROFILE },
      publishClip: true,
      clipPublisher: vi.fn(async () => longUrl),
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.platforms[0].items[0].checks).toEqual({ size: "fail" });
    // A fail is recorded, not a refusal — both files were still written.
    expect(store.packaged.map((p) => p.relativePath)).toEqual([BUNDLE_PATH, FALLBACK_PATH]);
  });

  test("publishes a selector used by two assets on two platforms exactly once per export", async () => {
    const second: PlatformProfile = { ...CLIP_PROFILE, id: "html-social", ratio: "9:16" };
    const store = fakeStore();
    const bundles: Record<string, Uint8Array> = {
      "alpha/1x1/index.html": bundleWith(1, "alpha/1x1/v0.mp4"),
      "alpha/1x1/fallback.png": FALLBACK,
      "alpha/9x16/index.html": bundleWith(1, "alpha/1x1/v0.mp4"),
      "alpha/9x16/fallback.png": FALLBACK,
    };
    vi.mocked(store.readAsset).mockImplementation(async (p) => bundles[p]!);
    const result = await exec(store, {
      assets: [
        html(),
        html({
          aspectRatio: "9:16",
          htmlBundlePath: "alpha/9x16/index.html",
          htmlFallbackPath: "alpha/9x16/fallback.png",
          variantIndex: 2,
        }),
      ],
      platforms: ["html-banner", "html-social"],
      profiles: { "html-banner": CLIP_PROFILE, "html-social": second },
      publishClip: true,
      clipPublisher: publisher,
    });
    expect(result.success).toBe(true);
    expect(publisher).toHaveBeenCalledTimes(1);
    expect(publisher).toHaveBeenCalledWith("alpha/1x1/v0.mp4");
    for (const written of store.packaged.filter((p) => p.relativePath.endsWith("index.html"))) {
      expect(new TextDecoder().decode(written.bytes)).toContain(urlFor("alpha/1x1/v0.mp4"));
    }
  });

  test("a second export publishes again — the per-export cache does not outlive execute()", async () => {
    const store = htmlStore(bundleWith(1, "alpha/1x1/v0.mp4"));
    const first = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": CLIP_PROFILE },
      publishClip: true,
      clipPublisher: publisher,
    });
    const second = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": CLIP_PROFILE },
      publishClip: true,
      clipPublisher: publisher,
    });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(publisher).toHaveBeenCalledTimes(2);
  });

  test("refuses every URL the safe-https pattern rejects, before any write", async () => {
    const unsafe = [
      "http://media.test/clip.mp4",
      'https://media.test/clip.mp4?x="',
      "https://media.test/a b.mp4",
      "https://media.test/<b>",
      "https://media.test/a&b",
      "",
      null,
    ];
    for (const bad of unsafe) {
      const store = htmlStore(bundleWith(1, "alpha/1x1/v0.mp4"));
      const result = await exec(store, {
        assets: [html()],
        platforms: ["html-banner"],
        profiles: { "html-banner": CLIP_PROFILE },
        publishClip: true,
        clipPublisher: vi.fn(async () => bad as string),
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe(
          'Platform "html-banner": The clip publisher returned an unsafe URL for video placeholder "alpha/1x1/v0.mp4" — expected an absolute https URL with no whitespace, quotes, angle brackets or ampersands.',
        );
      }
      expect(store.writePackaged).not.toHaveBeenCalled();
      expect(store.writeManifest).not.toHaveBeenCalled();
    }
  });

  test("refuses when the publisher throws, wrapping the message for the platform", async () => {
    const store = htmlStore(bundleWith(1, "alpha/1x1/v0.mp4"));
    const result = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": CLIP_PROFILE },
      publishClip: true,
      clipPublisher: vi.fn(async () => {
        throw new Error("the public bucket refused the publish");
      }),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Platform "html-banner": the public bucket refused the publish',
      );
    }
    expect(store.writePackaged).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("refuses a malformed placeholder token with the finder's message, before any write", async () => {
    const store = htmlStore(
      new TextEncoder().encode(`<video src="${PUBLISH_PLACEHOLDER_URL_PREFIX}"></video>`),
    );
    const result = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": CLIP_PROFILE },
      publishClip: true,
      clipPublisher: publisher,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('Platform "html-banner": findVideoPlaceholders:');
      expect(result.error.message).toContain("malformed video placeholder token");
    }
    expect(publisher).not.toHaveBeenCalled();
    expect(store.writePackaged).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("refuses when the bundle cannot be read, before any write", async () => {
    const store = fakeStore();
    vi.mocked(store.readAsset).mockRejectedValue(
      new Error("Asset not found: alpha/1x1/index.html"),
    );
    const result = await exec(store, {
      assets: [html()],
      platforms: ["html-banner"],
      profiles: { "html-banner": CLIP_PROFILE },
      publishClip: true,
      clipPublisher: publisher,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Platform "html-banner": Asset not found: alpha/1x1/index.html',
      );
    }
    expect(store.writePackaged).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  // Prepare-then-write (CFAR6C3 fix): packaging resolves every asset of every
  // platform BEFORE writing anything, so a refusal on a later asset or platform
  // must leave zero packaged files and zero manifests — not the earlier ones.
  const SECOND_BUNDLE_PATH = "alpha/1x1/take2/index.html";
  const SECOND_FALLBACK_PATH = "alpha/1x1/take2/fallback.png";
  const multiAssetStore = () => {
    const store = fakeStore();
    const bytesFor: Record<string, Uint8Array> = {
      [BUNDLE_PATH]: new TextEncoder().encode("<!DOCTYPE html><html><body>plain</body></html>"),
      [FALLBACK_PATH]: FALLBACK,
      [SECOND_BUNDLE_PATH]: bundleWith(1, "alpha/1x1/v1.mp4"),
      [SECOND_FALLBACK_PATH]: FALLBACK,
    };
    vi.mocked(store.readAsset).mockImplementation(async (p) => bytesFor[p]!);
    return store;
  };
  const secondAsset = (): GeneratedAsset =>
    html({
      htmlBundlePath: SECOND_BUNDLE_PATH,
      htmlFallbackPath: SECOND_FALLBACK_PATH,
      variantIndex: 2,
    });

  test("a later asset's unpublished placeholder leaves zero packaged files and manifests", async () => {
    const store = multiAssetStore();
    const result = await exec(store, {
      assets: [html(), secondAsset()],
      platforms: ["html-banner"],
      profiles: { "html-banner": CLIP_PROFILE },
      publishClip: false,
      clipPublisher: publisher,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Platform "html-banner": HTML asset alpha/v2 carries video clip placeholders but "publishClip" is not enabled — packaging would ship unresolvable placeholder URLs.',
      );
    }
    expect(store.writePackaged).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("a later asset's unsafe URL leaves zero packaged files and manifests", async () => {
    const store = multiAssetStore();
    const result = await exec(store, {
      assets: [html(), secondAsset()],
      platforms: ["html-banner"],
      profiles: { "html-banner": CLIP_PROFILE },
      publishClip: true,
      clipPublisher: vi.fn(async (selector) =>
        selector.includes("v1.mp4") ? "http://media.test/clip.mp4" : urlFor(selector),
      ),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Platform "html-banner": The clip publisher returned an unsafe URL for video placeholder "alpha/1x1/v1.mp4" — expected an absolute https URL with no whitespace, quotes, angle brackets or ampersands.',
      );
    }
    expect(store.writePackaged).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("a later asset's publisher failure leaves zero packaged files and manifests", async () => {
    const store = multiAssetStore();
    const result = await exec(store, {
      assets: [html(), secondAsset()],
      platforms: ["html-banner"],
      profiles: { "html-banner": CLIP_PROFILE },
      publishClip: true,
      clipPublisher: vi.fn(async (selector) => {
        if (selector.includes("v1.mp4")) throw new Error("the public bucket refused the publish");
        return urlFor(selector);
      }),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Platform "html-banner": the public bucket refused the publish',
      );
    }
    expect(store.writePackaged).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });

  test("a later platform's refusal leaves zero packaged files and manifests for earlier platforms", async () => {
    const second: PlatformProfile = { ...CLIP_PROFILE, id: "html-social", ratio: "9:16" };
    const store = fakeStore();
    const bytesFor: Record<string, Uint8Array> = {
      [BUNDLE_PATH]: new TextEncoder().encode("<!DOCTYPE html><html><body>plain</body></html>"),
      [FALLBACK_PATH]: FALLBACK,
      "alpha/9x16/index.html": bundleWith(1, "alpha/9x16/v0.mp4"),
      "alpha/9x16/fallback.png": FALLBACK,
    };
    vi.mocked(store.readAsset).mockImplementation(async (p) => bytesFor[p]!);
    const result = await exec(store, {
      assets: [
        html(),
        html({
          aspectRatio: "9:16",
          htmlBundlePath: "alpha/9x16/index.html",
          htmlFallbackPath: "alpha/9x16/fallback.png",
          variantIndex: 2,
        }),
      ],
      platforms: ["html-banner", "html-social"],
      profiles: { "html-banner": CLIP_PROFILE, "html-social": second },
      publishClip: false,
      clipPublisher: publisher,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Platform "html-social": HTML asset alpha/v2 carries video clip placeholders but "publishClip" is not enabled — packaging would ship unresolvable placeholder URLs.',
      );
    }
    // The first platform packaged successfully in the old sequential flow —
    // now nothing is written at all.
    expect(store.writePackaged).not.toHaveBeenCalled();
    expect(store.writeManifest).not.toHaveBeenCalled();
  });
});

/** ISO BMFF box helpers — a tiny well-formed mp4 the clip validator accepts. */
const u32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
];

const type4 = (value: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < 4; i++) out.push(i < value.length ? value.charCodeAt(i) : 0x20);
  return out;
};

/** ISO BMFF box: header + payload. */
function box(type: string, payload: number[]): number[] {
  return [...u32(payload.length + 8), ...type4(type), ...payload];
}

function ftyp(): number[] {
  return box("ftyp", [...type4("isom"), ...u32(0), ...["isom", "mp41"].map(type4).flat()]);
}

/** `mvhd` FullBox payload, version 0: version+flags, creation, modification, timescale, duration. */
function mvhd(timescale: number, duration: number): number[] {
  return box("mvhd", [
    0,
    0,
    0,
    0, // version 0 + flags
    0,
    0,
    0,
    0, // creation
    0,
    0,
    0,
    0, // modification
    ...u32(timescale),
    ...u32(duration),
  ]);
}

function hdlr(handler: string): number[] {
  return box("hdlr", [0, 0, 0, 0, 0, 0, 0, 0, ...type4(handler), ...new Array<number>(12).fill(0)]);
}

/** Visual sample entry (`avc1`/`avc3`/`hvc1`): 78 fixed bytes + child boxes. */
function sampleEntry(type: string, children: number[][]): number[] {
  return box(type, [...new Array<number>(78).fill(0), ...children.flat()]);
}

function avcC(): number[] {
  // Minimal plausible AVCDecoderConfigurationRecord; the validator only
  // requires the box type to be present.
  return box("avcC", [1, 100, 0, 28, 255, 225, 0, 24, 103, 100, 0, 40, 172, 52, 193]);
}

function stsd(entry: number[]): number[] {
  return box("stsd", [0, 0, 0, 0, ...u32(1), ...entry]);
}

function stbl(children: number[][]): number[] {
  return box("stbl", children.flat());
}

function minf(children: number[][]): number[] {
  return box("minf", children.flat());
}

function mdia(children: number[][]): number[] {
  return box("mdia", children.flat());
}

function trak(children: number[][]): number[] {
  return box("trak", children.flat());
}

function videoTrak(entryType: string): number[] {
  return trak([
    mdia([
      hdlr("vide"),
      minf([stbl([stsd(sampleEntry(entryType, entryType.startsWith("avc") ? [avcC()] : []))])]),
    ]),
  ]);
}

function moov(children: number[][]): number[] {
  return box("moov", children.flat());
}

/** ftyp + moov(mvhd + one `<entryType>` video trak). */
function clipBytes(
  entryType: string,
  opts?: { timescale?: number; duration?: number },
): Uint8Array {
  return new Uint8Array([
    ...ftyp(),
    ...moov([mvhd(opts?.timescale ?? 600, opts?.duration ?? 600), videoTrak(entryType)]),
  ]);
}

/** A tiny well-formed H.264 clip — passes `validateAdClip`. */
function tinyClip(opts?: { timescale?: number; duration?: number }): Uint8Array {
  return clipBytes("avc1", opts);
}

describe("generate → export through PackageForPlatformUseCase (CFAR6-slot, end to end)", () => {
  /**
   * The whole chain with in-memory stores only (CFAR6-slot): generate a
   * TWO-RATIO run, then the REAL export path `POST /campaigns/package` runs —
   * `PackageForPlatformUseCase` over `ObjectPackageStore`, reading renders and
   * bundles from the same in-memory object store the generate run saved to,
   * and publishing every bundle's placeholder selectors through the route's
   * `PublishAdClipUseCase` wiring. No network: the public bucket and the
   * ledger are the same fakes the use case's own tests use.
   */
  const ORG = "local";
  const CAMPAIGN = "0b9e6c1e-1111-4222-8333-444455556666";
  const RENDER_PREFIX = `org/${ORG}/campaign/${CAMPAIGN}/renders/`;
  const PACKAGE_PREFIX = `org/${ORG}/campaign/${CAMPAIGN}/packages/`;
  const SEGMENT = "camp";

  const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

  /** Two byte-distinct valid clips, one per ratio, so publishes are tellable apart. */
  const clipFor = (ratio: string): Uint8Array =>
    tinyClip({ duration: ratio === "1:1" ? 600 : 1200 });

  const videoTemplate = (render: string): BriefTemplate => ({
    ...CANONICAL_TEMPLATES["image-html"],
    id: "canonical-image-html",
    layers: [
      ...CANONICAL_TEMPLATES["image-html"].layers,
      { id: "video-1", kind: "video", props: { render } },
    ],
  });

  /** A video port handing each slot its own ratio's clip bytes. */
  const ratioClipVideoCompositor = (): VideoCompositorPort => ({
    ...fakeVideoCompositor(),
    compositeVideo: vi.fn(async (request: CompositeRequest) => ({
      video: clipFor(request.canvas.ratio ?? "1:1"),
      poster: new Uint8Array([4, 5, 6]),
      sampledFrames: [new Uint8Array([1]), new Uint8Array([2])],
      logoApplied: true,
    })),
  });

  const product = (id: string, over: Partial<Product> = {}): Product => ({
    id,
    name: id,
    primaryColor: "#1473E6",
    logoPath: `assets/inputs/${id}.png`,
    ...over,
  });

  const baseBrief = (over: Partial<CampaignBrief> = {}): CampaignBrief => ({
    schemaVersion: BRIEF_SCHEMA_VERSION,
    template: templateFromCanonical(over.type ?? DEFAULT_CAMPAIGN_TYPE),
    id: SEGMENT,
    targetRegion: "DE",
    targetAudience: "audience",
    campaignMessage: "Hello",
    products: [product("alpha")],
    ...over,
  });

  const variationBrief = (over: Partial<CampaignBrief> = {}): CampaignBrief =>
    baseBrief({ mode: "variation", variation: { count: 3, seed: 42 }, ...over });

  const generateDeps = (over: Partial<GenerateCampaignDeps> = {}): GenerateCampaignDeps => ({
    imageGenerator: fakeImageGenerator(),
    proceduralGenerator: fakeImageGenerator(),
    planner: fakePlanner(),
    compositor: fakeCompositor(),
    videoCompositor: fakeVideoCompositor(),
    sceneAssets: fakeSceneAssets(),
    audioAssets: fakeAudioAssets(),
    compliance: fakeCompliance(),
    exporter: recordingExporter(),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    ...over,
  });

  /** Generate a two-ratio, one-product run, capturing every saved bundle's bytes. */
  const generateTwoRatios = async (render: string) => {
    const d = generateDeps({
      planner: fakePlanner(
        fakePlan([fakeVariant(), fakeVariant({ index: 1, aspectRatio: "9:16" })]),
      ),
      videoCompositor: ratioClipVideoCompositor(),
    });
    const captures: Array<{ path: string; data: Uint8Array }> = [];
    const inner = d.exporter.saveToDirectory.bind(d.exporter);
    d.exporter.saveToDirectory = vi.fn(async (buf: Uint8Array, path: string) => {
      captures.push({ path, data: buf });
      await inner(buf, path);
    });
    const result = await new GenerateCampaignUseCase(d).execute(
      variationBrief({ products: [product("alpha")], template: videoTemplate(render) }),
    );
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("generate failed");
    const bundleHtml = (selector: string): string => {
      const bundle = captures.find(
        (c) => c.path === `camp/alpha/${selector.replace(/\.mp4$/, "")}/index.html`,
      );
      expect(bundle).toBeDefined();
      return new TextDecoder().decode(bundle!.data);
    };
    return { result, captures, bundleHtml };
  };

  /** A 1:1 and a 9:16 social-shaped profile that declare `html` — no shipped profile does yet; the test registers them. */
  const HTML_PROFILES: Record<string, PlatformProfile> = {
    "html-banner": {
      id: "html-banner",
      label: "HTML Banner",
      ratio: "1:1",
      formats: ["html"],
      safeInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      maxBytes: 8 * 1024 * 1024,
    },
    "html-story": {
      id: "html-story",
      label: "HTML Story",
      ratio: "9:16",
      formats: ["html"],
      safeInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      maxBytes: 8 * 1024 * 1024,
    },
  };

  /**
   * The export side, wired exactly as `POST /campaigns/package` does: every
   * generated file uploaded under the campaign's render prefix (campaign
   * segment dropped, what `renderObjectKey` does), the two clips on top, and
   * `PackageForPlatformUseCase` over `ObjectPackageStore` publishing each
   * distinct selector through `PublishAdClipUseCase`.
   */
  const exportThroughPackageUseCase = async (
    generated: Awaited<ReturnType<typeof generateTwoRatios>>,
  ) => {
    const store = new InMemoryObjectStore();
    for (const { path, data } of generated.captures) {
      await store.put(`${RENDER_PREFIX}${path.slice(`${SEGMENT}/`.length)}` as ObjectKey, data);
    }
    await store.put(`${RENDER_PREFIX}alpha/1x1/v0.mp4` as ObjectKey, clipFor("1:1"));
    await store.put(`${RENDER_PREFIX}alpha/9x16/v1.mp4` as ObjectKey, clipFor("9:16"));
    const media = fakePublicAdMedia();
    const ledger = fakePublishedClipRecord();
    const publish = new PublishAdClipUseCase({
      objectStore: store,
      publicAdMedia: media,
      publishedClipRecord: ledger,
      sha256,
    });
    const packageStore = new ObjectPackageStore(store, {
      renderPrefix: RENDER_PREFIX,
      packagePrefix: PACKAGE_PREFIX,
      campaignSegment: SEGMENT,
    });
    const urls: Record<string, string> = {};
    const clipPublisher = async (selector: string): Promise<string> => {
      const renderKey = renderObjectKey(RENDER_PREFIX, SEGMENT, `${SEGMENT}/${selector}`);
      const published = await publish.execute({ orgId: ORG, campaignId: CAMPAIGN, renderKey });
      urls[selector] = published.url;
      return published.url;
    };
    const packaged = await new PackageForPlatformUseCase(
      packageStore,
      (id) => HTML_PROFILES[id] ?? platformProfile(id),
    ).execute({
      campaignId: SEGMENT,
      assets: generated.result.value.assets,
      platforms: ["html-banner", "html-story"],
      packagedAt: "2026-01-01T00:00:00.000Z",
      publishClip: true,
      clipPublisher,
    });
    expect(packaged.success).toBe(true);
    if (!packaged.success) throw new Error(packaged.error.message);
    return { packaged, media, ledger, urls, store };
  };

  /** The packaged bundle bytes for one slot, read back from the store. */
  const packagedBundleHtml = async (store: InMemoryObjectStore, slot: string): Promise<string> => {
    const listed = await store.list(`${PACKAGE_PREFIX}` as ObjectKey);
    const key = listed.map((o) => o.key).find((k) => k.endsWith(`files/${slot}/index.html`));
    expect(key).toBeDefined();
    const object = await store.get(key!);
    expect(object).toBeDefined();
    return new TextDecoder().decode(object!.bytes);
  };

  test("a TWO-RATIO run publishes two DISTINCT clips, and each packaged bundle references its own", async () => {
    const generated = await generateTwoRatios("alpha/1x1/v0.mp4");
    const { packaged, media, ledger, urls, store } = await exportThroughPackageUseCase(generated);

    // Both slots' placeholders were found and published — one per slot, the
    // slot's own selector even though every slot's render names the 1:1 clip.
    expect(Object.keys(urls).sort()).toEqual(["alpha/1x1/v0.mp4", "alpha/9x16/v1.mp4"]);
    expect(media.publish).toHaveBeenCalledTimes(2);
    const hashes = vi.mocked(media.publish).mock.calls.map(([, , hash]) => hash as string);
    expect(hashes).toHaveLength(2);
    expect(new Set(hashes).size).toBe(2);
    expect(hashes).toContain(sha256(clipFor("1:1")));
    expect(hashes).toContain(sha256(clipFor("9:16")));
    expect(urls["alpha/1x1/v0.mp4"]).not.toBe(urls["alpha/9x16/v1.mp4"]);
    expect(await ledger.listForCampaign(ORG, CAMPAIGN)).toHaveLength(2);

    // Each packaged bundle carries ITS OWN published URL and no placeholder
    // prefix — the substitution happened on the real export path.
    const bundleOne = await packagedBundleHtml(store, "alpha/1x1/v0");
    const bundleNine = await packagedBundleHtml(store, "alpha/9x16/v1");
    expect(bundleOne).toContain(urls["alpha/1x1/v0.mp4"]);
    expect(bundleNine).toContain(urls["alpha/9x16/v1.mp4"]);
    expect(bundleOne).not.toContain(PUBLISH_PLACEHOLDER_URL_PREFIX);
    expect(bundleNine).not.toContain(PUBLISH_PLACEHOLDER_URL_PREFIX);
    expect(bundleOne).not.toContain(urls["alpha/9x16/v1.mp4"]);
    expect(bundleNine).not.toContain(urls["alpha/1x1/v0.mp4"]);
  });

  test("a render selector pointing at another mp4 of the campaign cannot make a bundle publish that other clip", async () => {
    // Every slot's render names the 1:1 clip — the OTHER slot's clip for the
    // 9:16 variant. The placeholder must still be the slot's own, so the
    // 9:16 bundle publishes the 9:16 clip bytes and nothing else.
    const generated = await generateTwoRatios("alpha/1x1/v0.mp4");
    const { media } = await exportThroughPackageUseCase(generated);

    const published = vi.mocked(media.publish).mock.calls.map(([, bytes]) => bytes as Uint8Array);
    expect(published).toHaveLength(2);
    expect(sha256(published[0]!)).toBe(sha256(clipFor("1:1")));
    expect(sha256(published[1]!)).toBe(sha256(clipFor("9:16")));
    expect(sha256(published[1]!)).not.toBe(sha256(clipFor("1:1")));
  });
});
