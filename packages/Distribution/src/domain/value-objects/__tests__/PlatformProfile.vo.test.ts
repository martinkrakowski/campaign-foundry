import { describe, test, expect } from "vitest";
import {
  PLATFORM_PROFILES,
  platformProfile,
  visiblePlatformIds,
} from "../PlatformProfile.vo.js";

const CANVASES = new Set(["1:1", "9:16", "16:9"]);

describe("PlatformProfile", () => {
  test("every profile uses one of the three canvases and carries the required fields", () => {
    for (const [id, profile] of Object.entries(PLATFORM_PROFILES)) {
      expect(profile.id).toBe(id);
      expect(CANVASES.has(profile.ratio)).toBe(true);
      expect(profile.label.length).toBeGreaterThan(0);
      expect(profile.formats.length).toBeGreaterThan(0);
      expect(profile.safeInsets).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
      expect(profile.maxBytes).toBeGreaterThan(0);
      expect(typeof profile.visible).toBe("boolean");
    }
  });

  test("hidden profiles are motion-only", () => {
    for (const profile of Object.values(PLATFORM_PROFILES)) {
      if (!profile.visible) expect(profile.formats).toEqual(["motion"]);
    }
  });

  test("visible profiles are static-only", () => {
    for (const profile of Object.values(PLATFORM_PROFILES)) {
      if (profile.visible) expect(profile.formats).toEqual(["static"]);
    }
  });

  test("visiblePlatformIds excludes motion-only platforms", () => {
    expect(visiblePlatformIds()).toEqual(["instagram-feed", "linkedin", "x"]);
  });

  test("platformProfile looks up by id or returns undefined", () => {
    expect(platformProfile("instagram-feed")?.ratio).toBe("1:1");
    expect(platformProfile("linkedin")?.ratio).toBe("1:1");
    expect(platformProfile("x")?.ratio).toBe("16:9");
    expect(platformProfile("tiktok")?.visible).toBe(false);
    expect(platformProfile("nope")).toBeUndefined();
  });

  test("static caps are 8 MiB and motion caps are 100 MiB", () => {
    expect(platformProfile("instagram-feed")?.maxBytes).toBe(8 * 1024 * 1024);
    expect(platformProfile("tiktok")?.maxBytes).toBe(100 * 1024 * 1024);
  });
});
