import { describe, test, expect, expectTypeOf } from "vitest";
import type { DisplaySize as PortDisplaySize, SafeInsets as PortSafeInsets } from "@campaignfoundry/CampaignOrchestration";
import { CAMPAIGN_TYPE_PRESETS } from "@campaignfoundry/CampaignOrchestration";
import {
  PLATFORM_PROFILES,
  formatsFor,
  isPlatformVisible,
  isRatioProfile,
  motionPackagedRatios,
  platformProfile,
  visiblePlatformIds,
  type DisplaySize,
  type SafeInsets,
} from "../PlatformProfile.vo.js";

const CANVASES = new Set(["1:1", "9:16", "16:9"]);
const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };

describe("PlatformProfile", () => {
  test("safeInsets is the compositor port's SafeInsets (D11)", () => {
    expectTypeOf<SafeInsets>().toEqualTypeOf<PortSafeInsets>();
    const zone: PortSafeInsets = platformProfile("instagram-reel")!.safeInsets;
    expect(zone.top).toBe(250);
  });

  test("every profile uses one of the three canvases and carries the required fields", () => {
    for (const [id, profile] of Object.entries(PLATFORM_PROFILES)) {
      expect(profile.id).toBe(id);
      if (profile.ratio !== undefined) expect(CANVASES.has(profile.ratio)).toBe(true);
      expect(profile.label.length).toBeGreaterThan(0);
      expect(profile.formats.length).toBeGreaterThan(0);
      for (const side of Object.values(profile.safeInsets)) expect(side).toBeGreaterThanOrEqual(0);
      expect(profile.maxBytes).toBeGreaterThan(0);
    }
  });

  test("static profiles keep zero insets (classic geometry) and no duration cap", () => {
    for (const profile of Object.values(PLATFORM_PROFILES)) {
      if (profile.formats.includes("static")) {
        expect(profile.safeInsets).toEqual(ZERO);
        expect(profile.maxDurationSec).toBeUndefined();
      }
    }
  });

  test("motion profiles are 9:16, carry a duration cap, and insets fit the canvas", () => {
    for (const profile of Object.values(PLATFORM_PROFILES)) {
      if (!profile.formats.includes("motion")) continue;
      expect(profile.ratio).toBe("9:16");
      expect(profile.maxDurationSec).toBeGreaterThan(0);
      expect(profile.safeInsets.top + profile.safeInsets.bottom).toBeLessThan(1920);
      expect(profile.safeInsets.left + profile.safeInsets.right).toBeLessThan(1080);
    }
  });

  test("visiblePlatformIds follows the motion capability", () => {
    expect(visiblePlatformIds({ motion: false })).toEqual([
      "instagram-feed",
      "linkedin",
      "x",
      "google-display",
      "meta-audience-network",
      "display-web",
    ]);
    expect(visiblePlatformIds({ motion: true })).toEqual([
      "instagram-feed",
      "linkedin",
      "x",
      "instagram-story",
      "instagram-reel",
      "tiktok",
      "youtube-short",
      "google-display",
      "meta-audience-network",
      "display-web",
    ]);
  });

  test("isPlatformVisible gates motion-only profiles on the capability", () => {
    expect(isPlatformVisible(platformProfile("tiktok")!, { motion: false })).toBe(false);
    expect(isPlatformVisible(platformProfile("tiktok")!, { motion: true })).toBe(true);
    expect(isPlatformVisible(platformProfile("x")!, { motion: false })).toBe(true);
  });

  test("a profile whose formats include html is always visible — html needs no host binary, unlike ffmpeg (D122)", () => {
    const feed = platformProfile("instagram-feed")!;
    const htmlProfile = { ...feed, id: "html-banner", formats: ["html"] as const };
    expect(isPlatformVisible(htmlProfile, { motion: false })).toBe(true);
    // The same synthetic profile gated on motion (were it to carry it) still needs the probe.
    const motionPlusHtml = { ...feed, id: "html-tier", formats: ["static", "html", "motion"] as const };
    expect(isPlatformVisible(motionPlusHtml, { motion: false })).toBe(false);
    expect(isPlatformVisible(motionPlusHtml, { motion: true })).toBe(true);
  });

  test("platformProfile looks up by id or returns undefined", () => {
    expect(platformProfile("instagram-feed")?.ratio).toBe("1:1");
    expect(platformProfile("linkedin")?.ratio).toBe("1:1");
    expect(platformProfile("x")?.ratio).toBe("16:9");
    expect(platformProfile("instagram-reel")?.safeInsets).toEqual({ top: 250, right: 0, bottom: 340, left: 0 });
    expect(platformProfile("nope")).toBeUndefined();
  });

  test("static caps are 8 MiB and motion caps are 100 MiB", () => {
    expect(platformProfile("instagram-feed")?.maxBytes).toBe(8 * 1024 * 1024);
    expect(platformProfile("tiktok")?.maxBytes).toBe(100 * 1024 * 1024);
  });

  test("formatsFor extracts unique formats in canonical static-first order", () => {
    expect(formatsFor([])).toEqual([]);
    expect(formatsFor(["unknown-platform"])).toEqual([]);
    expect(formatsFor(["instagram-feed", "linkedin"])).toEqual(["static"]);
    expect(formatsFor(["instagram-story"])).toEqual(["motion"]);
    expect(formatsFor(["instagram-story", "x", "tiktok"])).toEqual(["static", "motion"]);
  });

  test("motionPackagedRatios extracts canvas ratios for motion platforms only", () => {
    expect(motionPackagedRatios([])).toEqual(new Set());
    expect(motionPackagedRatios(["instagram-feed", "linkedin", "x"])).toEqual(new Set());
    expect(motionPackagedRatios(["unknown-platform"])).toEqual(new Set());
    expect(motionPackagedRatios(["instagram-story"])).toEqual(new Set(["9:16"]));
    expect(motionPackagedRatios(["instagram-feed", "tiktok", "youtube-short"])).toEqual(new Set(["9:16"]));
  });

  // The campaign-type presets (D108–D112) live in CampaignOrchestration as plain
  // string platform ids, because the domain layer must not import this package.
  // This guard is the other half of the contract: a renamed or removed profile
  // fails here, in the package that owns the ids — so a preset can never name a
  // placement the compositor cannot render.
  describe("campaign-type preset coverage (D108–D112)", () => {
    test("every preset platform id is a PLATFORM_PROFILES id", () => {
      for (const [type, preset] of Object.entries(CAMPAIGN_TYPE_PRESETS)) {
        for (const id of preset.platforms) {
          expect(PLATFORM_PROFILES[id], `${type} names unknown platform "${id}"`).toBeDefined();
        }
      }
    });

    // D111: paid-social is every *social* surface — every profile with a ratio.
    // Display profiles carry `sizes` instead (D116); A5 maps `display-ad` onto
    // those. Membership above cannot catch a dropped social id; this pins the
    // list to the ratio-bearing keys, not a second copy of the table.
    test("paid-social lists every PLATFORM_PROFILES id", () => {
      const listed = [...CAMPAIGN_TYPE_PRESETS["paid-social"].platforms].sort();
      const all = Object.keys(PLATFORM_PROFILES)
        .filter((id) => isRatioProfile(PLATFORM_PROFILES[id]!))
        .sort();
      const missing = all.filter((id) => !listed.includes(id));
      const extra = listed.filter((id) => !all.includes(id));
      const reasons: string[] = [];
      if (missing.length > 0) reasons.push(`missing ${missing.map((id) => `"${id}"`).join(", ")}`);
      if (extra.length > 0) reasons.push(`extra ${extra.map((id) => `"${id}"`).join(", ")}`);
      expect(listed, `paid-social ${reasons.join("; ")}`).toEqual(all);
    });

    test("every preset's formats agree with the profiles it lists", () => {
      for (const [type, preset] of Object.entries(CAMPAIGN_TYPE_PRESETS)) {
        const motionOnly = !preset.formats.includes("static");
        const staticOnly = !preset.formats.includes("motion");
        const packaged = new Set<string>();
        for (const id of preset.platforms) {
          const profile = PLATFORM_PROFILES[id];
          if (!profile) continue;
          for (const format of profile.formats) {
            packaged.add(format);
            expect(
              preset.formats,
              `${type} lists "${id}", which packages "${format}" the preset does not offer`,
            ).toContain(format);
          }
          // A preset's format choice is also its ratio family: a motion-only
          // preset lists only the 9:16 motion profiles, a static-only one only
          // the still surfaces — read off the profile's own fields, not a
          // hard-coded id list.
          if (motionOnly) {
            expect(profile.ratio, `${type} is motion-only but "${id}" is not a 9:16 motion profile`).toBe("9:16");
          }
          if (staticOnly) {
            expect(
              profile.formats.includes("motion"),
              `${type} is static-only but "${id}" is a motion profile`,
            ).toBe(false);
          }
        }
        // Reverse: every format the preset offers must be packaged by at
        // least one listed profile. Read off the profiles — no hard-coded
        // ids or formats. A motion-only type that starts offering "static"
        // would otherwise stay green.
        for (const format of preset.formats) {
          expect(
            packaged,
            `${type} offers "${format}" but none of its listed profiles package it`,
          ).toContain(format);
        }
      }
    });
  });

  describe("display profiles (D116, F5)", () => {
    const DISPLAY_IDS = ["google-display", "meta-audience-network", "display-web"] as const;

    test("DisplaySize is CampaignOrchestration's DisplaySize", () => {
      expectTypeOf<DisplaySize>().toEqualTypeOf<PortDisplaySize>();
    });

    test("every profile carries exactly one of ratio/sizes, and every display size has insets", () => {
      for (const [id, profile] of Object.entries(PLATFORM_PROFILES)) {
        const hasRatio = profile.ratio !== undefined;
        const hasSizes = profile.sizes !== undefined;
        expect(hasRatio, `${id} must carry exactly one of ratio/sizes`).not.toBe(hasSizes);
        if (!hasSizes) {
          expect(isRatioProfile(profile)).toBe(true);
          continue;
        }
        expect(isRatioProfile(profile)).toBe(false);
        expect(profile.sizes!.length, `${id} sizes must not be empty`).toBeGreaterThan(0);
        for (const slot of profile.sizes!) {
          expect(slot.insets, `${id} ${slot.size} missing insets`).toBeDefined();
          for (const side of Object.values(slot.insets)) {
            expect(side, `${id} ${slot.size} inset`).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });

    test("the three display profiles are static-only and list the sizes each network accepts", () => {
      const google = platformProfile("google-display");
      const meta = platformProfile("meta-audience-network");
      const web = platformProfile("display-web");
      expect(google?.formats).toEqual(["static"]);
      expect(meta?.formats).toEqual(["static"]);
      expect(web?.formats).toEqual(["static"]);
      expect(google?.sizes?.map((slot) => slot.size)).toEqual([
        "300x250",
        "728x90",
        "160x600",
        "320x50",
        "300x600",
      ]);
      expect(meta?.sizes?.map((slot) => slot.size)).toEqual(["300x250", "320x50", "300x600"]);
      expect(web?.sizes?.map((slot) => slot.size)).toEqual(google?.sizes?.map((slot) => slot.size));
    });

    test("320x50 and 728x90 carry zero insets; the other units carry a uniform 8 px", () => {
      for (const id of DISPLAY_IDS) {
        const profile = platformProfile(id)!;
        for (const slot of profile.sizes ?? []) {
          if (slot.size === "320x50" || slot.size === "728x90") {
            expect(slot.insets, `${id} ${slot.size}`).toEqual(ZERO);
          } else {
            expect(slot.insets, `${id} ${slot.size}`).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });
          }
        }
      }
    });

    test("isRatioProfile is true only for the seven social profiles", () => {
      const social = Object.values(PLATFORM_PROFILES).filter(isRatioProfile).map((profile) => profile.id);
      expect(social).toEqual([
        "instagram-feed",
        "linkedin",
        "x",
        "instagram-story",
        "instagram-reel",
        "tiktok",
        "youtube-short",
      ]);
      const feed = platformProfile("instagram-feed")!;
      expect(isRatioProfile({ ...feed, sizes: [{ size: "300x250", insets: ZERO }] })).toBe(false);
    });
  });
});

