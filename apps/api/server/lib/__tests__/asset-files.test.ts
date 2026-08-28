import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSET_NAME_PATTERN,
  decodeBase64,
  hasAllowedImageMagic,
  assetRelPath,
} from "../asset-files.js";

const origRoot = process.env.PROJECT_ROOT;
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

describe("ASSET_NAME_PATTERN", () => {
  test("accepts a SAFE_ID_PATTERN stem with a png/jpg/jpeg extension", () => {
    for (const name of ["a.png", "logo.jpg", "hydra-logo.jpeg", `${"a".repeat(64)}.png`]) {
      expect(ASSET_NAME_PATTERN.test(name), name).toBe(true);
    }
  });

  test("rejects names that would escape or are not a basename image", () => {
    for (const name of [
      "../hydra-logo.png",
      "foo/bar.png",
      "/tmp/x.png",
      "hydra-logo.PNG",
      "a.gif",
      "",
      "a".repeat(65) + ".png",
    ]) {
      expect(ASSET_NAME_PATTERN.test(name), name).toBe(false);
    }
  });
});

describe("decodeBase64", () => {
  test("decodes standard base64", () => {
    expect(decodeBase64(png.toString("base64"))).toEqual(png);
  });

  test.each([
    ["a non-string", 1],
    ["an empty string", ""],
    ["a length not divisible by 4", "abc"],
    ["an invalid alphabet", "@@@@"],
    ["a url-safe alphabet", "aa-a"],
  ])("rejects %s", (_label, value) => {
    expect(decodeBase64(value)).toBeUndefined();
  });
});

describe("hasAllowedImageMagic", () => {
  test("accepts PNG and JPEG magic", () => {
    expect(hasAllowedImageMagic(png)).toBe(true);
    expect(hasAllowedImageMagic(jpeg)).toBe(true);
  });

  test("rejects too-short or non-image buffers", () => {
    expect(hasAllowedImageMagic(Buffer.from([0xff, 0xd8]))).toBe(false);
    expect(hasAllowedImageMagic(Buffer.from([0x00, 0x00, 0x00, 0x00]))).toBe(false);
    expect(hasAllowedImageMagic(Buffer.from([0x89, 0x50, 0x4e]))).toBe(false);
  });
});

describe("asset paths", () => {
  let dir: string;

  const filesFor = async (root: string) => {
    vi.resetModules();
    process.env.PROJECT_ROOT = root;
    return import("../asset-files.js");
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cf-asset-files-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = origRoot;
  });

  test("assetRelPath is the repo-relative logoPath a brief can store", () => {
    expect(assetRelPath("camp", "logo.png")).toBe("assets/inputs/camp/logo.png");
  });

  test("assetAbsPath formats path under assets/inputs/<briefId>/ and rejects escape", async () => {
    const { assetAbsPath } = await filesFor(dir);
    const dest = assetAbsPath("camp", "logo.png");
    expect(dest).toBe(join(dir, "assets", "inputs", "camp", "logo.png"));
    expect(() => assetAbsPath("camp", "../hydra-logo.png")).toThrow(
      /Path escapes the allowed directory/,
    );
  });
});

describe("rewriteAssetPath and rewriteAssetPaths", () => {
  test("rewrites paths starting with assets/inputs/<from>/ to assets/inputs/<to>/", async () => {
    const { rewriteAssetPath } = await import("../asset-files.js");
    expect(rewriteAssetPath("assets/inputs/old-camp/logo.png", "old-camp", "new-camp")).toBe(
      "assets/inputs/new-camp/logo.png",
    );
    expect(rewriteAssetPath("assets/inputs/old-camp/nested/bg.jpg", "old-camp", "new-camp")).toBe(
      "assets/inputs/new-camp/nested/bg.jpg",
    );
  });

  test("leaves root-level assets and different brief ids untouched", async () => {
    const { rewriteAssetPath } = await import("../asset-files.js");
    expect(rewriteAssetPath("assets/inputs/hydra-logo.png", "old-camp", "new-camp")).toBe(
      "assets/inputs/hydra-logo.png",
    );
    expect(rewriteAssetPath("assets/inputs/other-camp/logo.png", "old-camp", "new-camp")).toBe(
      "assets/inputs/other-camp/logo.png",
    );
    expect(rewriteAssetPath("custom/path/logo.png", "old-camp", "new-camp")).toBe(
      "custom/path/logo.png",
    );
  });

  test("rewriteAssetPaths rewrites both logoPath and inputAsset on brief products", async () => {
    const { rewriteAssetPaths } = await import("../asset-files.js");
    const brief = {
      id: "new-camp",
      targetRegion: "US",
      targetAudience: "all",
      campaignMessage: "msg",
      products: [
        {
          id: "p1",
          name: "P1",
          primaryColor: "#111111",
          logoPath: "assets/inputs/old-camp/logo1.png",
          inputAsset: "assets/inputs/old-camp/bg1.jpg",
        },
        {
          id: "p2",
          name: "P2",
          primaryColor: "#222222",
          logoPath: "assets/inputs/hydra-logo.png", // root level
          inputAsset: "assets/inputs/reuse-bg.png", // root level
        },
      ],
    };

    const rewritten = rewriteAssetPaths(brief, "old-camp", "new-camp");
    expect(rewritten.products[0].logoPath).toBe("assets/inputs/new-camp/logo1.png");
    expect(rewritten.products[0].inputAsset).toBe("assets/inputs/new-camp/bg1.jpg");
    expect(rewritten.products[1].logoPath).toBe("assets/inputs/hydra-logo.png");
    expect(rewritten.products[1].inputAsset).toBe("assets/inputs/reuse-bg.png");
  });

  test("extractSourceAssetBriefIds finds distinct source brief IDs excluding target", async () => {
    const { extractSourceAssetBriefIds } = await import("../asset-files.js");
    const brief = {
      id: "target-camp",
      targetRegion: "US",
      targetAudience: "all",
      campaignMessage: "msg",
      products: [
        {
          id: "p1",
          name: "P1",
          primaryColor: "#111111",
          logoPath: "assets/inputs/source-a/logo.png",
          inputAsset: "assets/inputs/source-b/bg.jpg",
        },
        {
          id: "p2",
          name: "P2",
          primaryColor: "#222222",
          logoPath: "assets/inputs/source-a/logo2.png", // repeated source-a
          inputAsset: "assets/inputs/reuse-bg.png", // root level (ignored)
        },
        {
          id: "p3",
          name: "P3",
          primaryColor: "#333333",
          logoPath: "assets/inputs/target-camp/already-target.png", // matches target (ignored)
        },
      ],
    };

    const sourceIds = extractSourceAssetBriefIds(brief, "target-camp");
    expect(sourceIds.sort()).toEqual(["source-a", "source-b"]);
  });

  test("rewriteAssetPaths and extractSourceAssetBriefIds handle missing or malformed products gracefully", async () => {
    const { rewriteAssetPaths, extractSourceAssetBriefIds } = await import("../asset-files.js");
    const invalidBrief = { id: "test" } as unknown as import("@campaignfoundry/CampaignOrchestration").CampaignBrief;
    expect(rewriteAssetPaths(invalidBrief, "a", "b")).toEqual(invalidBrief);
    expect(extractSourceAssetBriefIds(invalidBrief, "b")).toEqual([]);
  });
});

