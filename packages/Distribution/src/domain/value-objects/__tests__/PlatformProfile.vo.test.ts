import { describe, test, expect, expectTypeOf } from "vitest";
import type { SafeInsets as PortSafeInsets } from "@campaignfoundry/CampaignOrchestration";
import {
  PLATFORM_PROFILES,
  isPlatformVisible,
  platformProfile,
  visiblePlatformIds,
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
      expect(CANVASES.has(profile.ratio)).toBe(true);
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
    expect(visiblePlatformIds({ motion: false })).toEqual(["instagram-feed", "linkedin", "x"]);
    expect(visiblePlatformIds({ motion: true })).toEqual([
      "instagram-feed",
      "linkedin",
      "x",
      "instagram-story",
      "instagram-reel",
      "tiktok",
      "youtube-short",
    ]);
  });

  test("isPlatformVisible gates motion-only profiles on the capability", () => {
    expect(isPlatformVisible(platformProfile("tiktok")!, { motion: false })).toBe(false);
    expect(isPlatformVisible(platformProfile("tiktok")!, { motion: true })).toBe(true);
    expect(isPlatformVisible(platformProfile("x")!, { motion: false })).toBe(true);
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
});
