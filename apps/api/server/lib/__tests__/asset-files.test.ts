import { describe, test, expect } from "vitest";
import {
  ASSET_NAME_PATTERN,
  AUDIO_ASSET_NAME_PATTERN,
  decodeBase64,
  hasAllowedImageMagic,
  hasAllowedAudioMagic,
  assetContentType,
  assetRelPath,
} from "../asset-files.js";
import {
  BRIEF_SCHEMA_VERSION,
  DEFAULT_CAMPAIGN_TYPE,
  templateFromCanonical,
} from "@campaignfoundry/CampaignOrchestration";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x00]);

describe("ASSET_NAME_PATTERN", () => {
  test("accepts a SAFE_ID_PATTERN stem with a png/jpg/jpeg/mp3/m4a extension", () => {
    for (const name of [
      "a.png",
      "logo.jpg",
      "hydra-logo.jpeg",
      `${"a".repeat(64)}.png`,
      "bed.mp3",
      "bed.m4a",
    ]) {
      expect(ASSET_NAME_PATTERN.test(name), name).toBe(true);
    }
  });

  test("rejects names that would escape or are not a basename image/audio asset", () => {
    for (const name of [
      "../hydra-logo.png",
      "foo/bar.png",
      "/tmp/x.png",
      "hydra-logo.PNG",
      "a.gif",
      "bed.MP3",
      "bed.wav",
      "",
      "a".repeat(65) + ".png",
    ]) {
      expect(ASSET_NAME_PATTERN.test(name), name).toBe(false);
    }
  });
});

describe("AUDIO_ASSET_NAME_PATTERN", () => {
  test("accepts mp3/m4a basenames only", () => {
    for (const name of ["bed.mp3", "bed.m4a"]) {
      expect(AUDIO_ASSET_NAME_PATTERN.test(name), name).toBe(true);
    }
  });

  test("rejects image basenames and anything ASSET_NAME_PATTERN would reject", () => {
    for (const name of ["logo.png", "photo.jpg", "photo.jpeg", "bed.wav", "../bed.mp3"]) {
      expect(AUDIO_ASSET_NAME_PATTERN.test(name), name).toBe(false);
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

// ID3v2 header: "ID3" + version(2) + flags(1) + syncsafe size(4) — the tag
// libmp3lame (ffmpeg-static's mp3 muxer) writes at the start of every file.
const mp3Id3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x22]);
// A bare MPEG frame sync (no ID3 tag): 11 set leading bits — 0xff, then the
// next byte's top 3 bits set (0xfb = 1111_1011).
const mp3FrameSync = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0x00, 0x00, 0x00, 0x00]);
// ISO-BMFF "ftyp" box: size(4, unchecked) + "ftyp" + major brand "M4A " — the
// exact bytes the pinned ffmpeg-static binary writes for `-c:a aac out.m4a`
// (verified against the vendored binary: `ffmpeg -f lavfi -i sine=440 -t 1
// -c:a aac x.m4a` → `00000000: 0000 001c 6674 7970 4d34 4120 ...` = size,
// "ftyp", "M4A ").
const m4aFtyp = Buffer.from([
  0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0x00, 0x00, 0x02, 0x00,
]);

describe("hasAllowedAudioMagic", () => {
  test("accepts an ID3-tagged mp3", () => {
    expect(hasAllowedAudioMagic(mp3Id3)).toBe(true);
  });

  test("accepts a bare MPEG frame-sync mp3 (no ID3 tag)", () => {
    expect(hasAllowedAudioMagic(mp3FrameSync)).toBe(true);
  });

  test("accepts an m4a ftyp box with an audio major brand", () => {
    expect(hasAllowedAudioMagic(m4aFtyp)).toBe(true);
  });

  test("rejects an ftyp box whose major brand is not an audio brand (e.g. a generic/video mp4)", () => {
    const genericMp4 = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02,
      0x00,
    ]);
    expect(hasAllowedAudioMagic(genericMp4)).toBe(false);
  });

  test("rejects PNG/JPEG magic — a renamed image is refused", () => {
    expect(hasAllowedAudioMagic(png)).toBe(false);
    expect(hasAllowedAudioMagic(jpeg)).toBe(false);
  });

  test("rejects too-short or arbitrary buffers", () => {
    expect(hasAllowedAudioMagic(Buffer.from([0xff]))).toBe(false);
    expect(hasAllowedAudioMagic(Buffer.from([0x00, 0x00, 0x00, 0x00]))).toBe(false);
    expect(hasAllowedAudioMagic(Buffer.alloc(0))).toBe(false);
  });
});

describe("assetContentType", () => {
  test.each([
    ["logo.png", "image/png"],
    ["photo.jpg", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["bed.mp3", "audio/mpeg"],
    ["bed.m4a", "audio/mp4"],
  ])("%s -> %s", (name, expected) => {
    expect(assetContentType(name)).toBe(expected);
  });
});

describe("asset paths", () => {
  test("assetRelPath is the repo-relative logoPath a brief can store", () => {
    expect(assetRelPath("camp", "logo.png")).toBe("assets/inputs/camp/logo.png");
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
    expect(
      rewriteAssetPath("assets/inputs/old-camp/logo.png", "old-camp", "new-camp", {
        "logo.png": "logo-disambiguated.png",
      }),
    ).toBe("assets/inputs/new-camp/logo-disambiguated.png");
    expect(
      rewriteAssetPath("assets/inputs/old-camp/logo.png", "old-camp", "new-camp", {
        "assets/inputs/old-camp/logo.png": "assets/inputs/new-camp/logo-custom.png",
      }),
    ).toBe("assets/inputs/new-camp/logo-custom.png");
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
      schemaVersion: BRIEF_SCHEMA_VERSION,
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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

  test("rewriteAssetPaths rewrites brief-level audio.path like logoPath/inputAsset (VE-D8)", async () => {
    const { rewriteAssetPaths } = await import("../asset-files.js");
    const brief = {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
      id: "new-camp",
      targetRegion: "US",
      targetAudience: "all",
      campaignMessage: "msg",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/p1.png" },
      ],
      audio: {
        path: "assets/inputs/old-camp/bed.mp3",
        rights: { licenceId: "lic-1", source: "acme" },
      },
    };

    const rewritten = rewriteAssetPaths(brief, "old-camp", "new-camp");
    expect(rewritten.audio?.path).toBe("assets/inputs/new-camp/bed.mp3");
    expect(rewritten.audio?.rights).toEqual(brief.audio.rights);
  });

  test("rewriteAssetPaths leaves a root-level audio.path and an absent audio block untouched (VE-D3)", async () => {
    const { rewriteAssetPaths } = await import("../asset-files.js");
    const withRootAudio = {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
      id: "new-camp",
      targetRegion: "US",
      targetAudience: "all",
      campaignMessage: "msg",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/p1.png" },
      ],
      audio: {
        path: "assets/inputs/shared-bed.mp3",
        rights: { licenceId: "lic-1", source: "acme" },
      },
    };
    expect(rewriteAssetPaths(withRootAudio, "old-camp", "new-camp").audio?.path).toBe(
      "assets/inputs/shared-bed.mp3",
    );

    const withoutAudio = { ...withRootAudio, audio: undefined };
    delete (withoutAudio as { audio?: unknown }).audio;
    const rewritten = rewriteAssetPaths(withoutAudio, "old-camp", "new-camp");
    expect("audio" in rewritten).toBe(false);
  });

  test("extractSourceAssetBriefIds includes the brief-level audio.path source id (VE-D8)", async () => {
    const { extractSourceAssetBriefIds } = await import("../asset-files.js");
    const brief = {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
      id: "target-camp",
      targetRegion: "US",
      targetAudience: "all",
      campaignMessage: "msg",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/p1.png" },
      ],
      audio: {
        path: "assets/inputs/source-c/bed.mp3",
        rights: { licenceId: "lic-1", source: "acme" },
      },
    };
    expect(extractSourceAssetBriefIds(brief, "target-camp")).toEqual(["source-c"]);
  });

  test("extractSourceAssetBriefIds ignores a root-level audio.path and one already at the target (VE-D8)", async () => {
    const { extractSourceAssetBriefIds } = await import("../asset-files.js");
    const base = {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
      id: "target-camp",
      targetRegion: "US",
      targetAudience: "all",
      campaignMessage: "msg",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/p1.png" },
      ],
    };
    // Root-level: no `assets/inputs/<id>/` prefix at all — the pattern does not match.
    expect(
      extractSourceAssetBriefIds(
        {
          ...base,
          audio: {
            path: "assets/inputs/shared-bed.mp3",
            rights: { licenceId: "lic-1", source: "acme" },
          },
        },
        "target-camp",
      ),
    ).toEqual([]);
    // Already scoped to the target brief — matches, but is not a distinct source.
    expect(
      extractSourceAssetBriefIds(
        {
          ...base,
          audio: {
            path: "assets/inputs/target-camp/bed.mp3",
            rights: { licenceId: "lic-1", source: "acme" },
          },
        },
        "target-camp",
      ),
    ).toEqual([]);
  });

  test("extractSourceAssetBriefIds finds distinct source brief IDs excluding target", async () => {
    const { extractSourceAssetBriefIds } = await import("../asset-files.js");
    const brief = {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
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

  test("rewriteAssetPaths rewrites copy.timeline.beats[].background paths (VE5b2)", async () => {
    const { rewriteAssetPaths } = await import("../asset-files.js");
    const brief = {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
      id: "new-camp",
      targetRegion: "US",
      targetAudience: "all",
      campaignMessage: "msg",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/p1.png" },
      ],
      copy: {
        timeline: {
          transition: "fade" as const,
          keyBeat: 1,
          beats: [
            { text: "Alpha", weight: 1, background: "assets/inputs/old-camp/scene-a.png" },
            { text: "Beta", weight: 1 },
            { text: "Gamma", weight: 1, background: "assets/inputs/hydra-logo.png" },
          ],
        },
      },
    };

    const rewritten = rewriteAssetPaths(brief, "old-camp", "new-camp");
    expect(rewritten.copy?.timeline?.beats[0]).toEqual({
      text: "Alpha",
      weight: 1,
      background: "assets/inputs/new-camp/scene-a.png",
    });
    // A beat naming no background stays exactly as it was — never gains a `background: undefined` key.
    expect(rewritten.copy?.timeline?.beats[1]).toEqual({ text: "Beta", weight: 1 });
    expect("background" in (rewritten.copy?.timeline?.beats[1] ?? {})).toBe(false);
    // Root-level assets (no brief-id prefix) are untouched.
    expect(rewritten.copy?.timeline?.beats[2]?.background).toBe("assets/inputs/hydra-logo.png");
  });

  test("rewriteAssetPaths leaves an absent copy/timeline untouched — never fabricates the key (VE-D3)", async () => {
    const { rewriteAssetPaths } = await import("../asset-files.js");
    const withoutCopy = {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
      id: "new-camp",
      targetRegion: "US",
      targetAudience: "all",
      campaignMessage: "msg",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/p1.png" },
      ],
    };
    expect("copy" in rewriteAssetPaths(withoutCopy, "old-camp", "new-camp")).toBe(false);

    const withTimelineNoBackgrounds = {
      ...withoutCopy,
      copy: {
        timeline: { transition: "cut" as const, keyBeat: 1, beats: [{ text: "Alpha", weight: 1 }] },
      },
    };
    const rewritten = rewriteAssetPaths(withTimelineNoBackgrounds, "old-camp", "new-camp");
    expect(rewritten.copy).toBe(withTimelineNoBackgrounds.copy);
  });

  test("extractSourceAssetBriefIds finds distinct source brief IDs from copy.timeline.beats[].background (VE5b2)", async () => {
    const { extractSourceAssetBriefIds } = await import("../asset-files.js");
    const brief = {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
      id: "target-camp",
      targetRegion: "US",
      targetAudience: "all",
      campaignMessage: "msg",
      products: [
        { id: "p1", name: "P1", primaryColor: "#111111", logoPath: "assets/inputs/p1.png" },
      ],
      copy: {
        timeline: {
          transition: "cut" as const,
          keyBeat: 1,
          beats: [
            { text: "Alpha", weight: 1, background: "assets/inputs/scene-source/a.png" },
            { text: "Beta", weight: 1 },
            { text: "Gamma", weight: 1, background: "assets/inputs/target-camp/b.png" },
          ],
        },
      },
    };
    expect(extractSourceAssetBriefIds(brief, "target-camp")).toEqual(["scene-source"]);
  });

  test("extractSourceAssetBriefIds still scans audio.path and beats[].background when a brief has no products", async () => {
    const { extractSourceAssetBriefIds } = await import("../asset-files.js");
    const noProducts = {
      schemaVersion: BRIEF_SCHEMA_VERSION,
      template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
      id: "target-camp",
      targetRegion: "US",
      targetAudience: "all",
      campaignMessage: "msg",
      products: [],
      audio: {
        path: "assets/inputs/audio-source/bed.mp3",
        rights: { licenceId: "lic-1", source: "acme" },
      },
      copy: {
        timeline: {
          transition: "cut" as const,
          keyBeat: 1,
          beats: [{ text: "Alpha", weight: 1, background: "assets/inputs/scene-source/a.png" }],
        },
      },
    } as unknown as import("@campaignfoundry/CampaignOrchestration").CampaignBrief;

    expect(extractSourceAssetBriefIds(noProducts, "target-camp").sort()).toEqual([
      "audio-source",
      "scene-source",
    ]);

    // Missing/malformed products (not merely empty) must also not block the scan.
    const malformedProducts = {
      ...noProducts,
      products: undefined,
    } as unknown as import("@campaignfoundry/CampaignOrchestration").CampaignBrief;
    expect(extractSourceAssetBriefIds(malformedProducts, "target-camp").sort()).toEqual([
      "audio-source",
      "scene-source",
    ]);
  });

  test("rewriteAssetPaths and extractSourceAssetBriefIds handle missing or malformed products gracefully", async () => {
    const { rewriteAssetPaths, extractSourceAssetBriefIds } = await import("../asset-files.js");
    const invalidBrief = {
      id: "test",
    } as unknown as import("@campaignfoundry/CampaignOrchestration").CampaignBrief;
    expect(rewriteAssetPaths(invalidBrief, "a", "b")).toEqual(invalidBrief);
    expect(extractSourceAssetBriefIds(invalidBrief, "b")).toEqual([]);
  });
});
