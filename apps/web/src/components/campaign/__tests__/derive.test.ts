import { describe, test, expect } from "vitest";
import { DISPLAY_SIZE_VALUES } from "@campaignfoundry/CampaignOrchestration/display-sizes";
import { platformsToFormats, platformsToRatios, platformsToSizes, clampPolicy } from "../derive";
import { initialEditorState, axisProductSize } from "../editor-state";

describe("derive.ts", () => {
  describe("platformsToFormats", () => {
    test("returns static when platforms is empty or invalid", () => {
      expect(platformsToFormats([])).toEqual(["static"]);
      expect(platformsToFormats(["nonexistent"])).toEqual(["static"]);
    });

    test("derives static for photo-only platforms in canonical order", () => {
      expect(platformsToFormats(["instagram-feed", "linkedin"])).toEqual(["static"]);
    });

    test("derives motion for video-only platforms", () => {
      expect(platformsToFormats(["instagram-story", "tiktok"])).toEqual(["motion"]);
    });

    test("derives static and motion for mixed platforms in canonical order", () => {
      expect(platformsToFormats(["tiktok", "instagram-feed"])).toEqual(["static", "motion"]);
    });

    test("a mixed social+display selection stays static when no motion platform is selected", () => {
      expect(platformsToFormats(["instagram-feed", "google-display"])).toEqual(["static"]);
    });
  });

  describe("platformsToRatios", () => {
    test("returns empty array for empty or invalid platforms", () => {
      expect(platformsToRatios([])).toEqual([]);
      expect(platformsToRatios(["nonexistent"])).toEqual([]);
    });

    test("derives canonical ratios from platforms", () => {
      expect(platformsToRatios(["instagram-feed"])).toEqual(["1:1"]);
      expect(platformsToRatios(["instagram-feed", "x"])).toEqual(["1:1", "16:9"]);
      expect(platformsToRatios(["instagram-story", "linkedin"])).toEqual(["1:1", "9:16"]);
      expect(platformsToRatios(["instagram-reel", "x", "instagram-feed"])).toEqual(["1:1", "9:16", "16:9"]);
    });

    test("a display profile contributes no ratio, even in a mixed selection", () => {
      // Treating a display profile as "1:1" would make the empty case below fail.
      expect(platformsToRatios(["google-display"])).toEqual([]);
      expect(platformsToRatios(["instagram-feed", "google-display"])).toEqual(["1:1"]);
    });
  });

  describe("platformsToSizes", () => {
    test("returns empty for empty, invalid, or social-only platforms", () => {
      expect(platformsToSizes([])).toEqual([]);
      expect(platformsToSizes(["nonexistent"])).toEqual([]);
      expect(platformsToSizes(["instagram-feed", "linkedin"])).toEqual([]);
    });

    test("dedupes in DISPLAY_SIZE_VALUES order, not insertion order", () => {
      expect(platformsToSizes(["google-display", "meta-audience-network"])).toEqual([...DISPLAY_SIZE_VALUES]);
      expect(platformsToSizes(["meta-audience-network", "google-display"])).toEqual([...DISPLAY_SIZE_VALUES]);
    });
  });

  describe("clampPolicy", () => {
    test("clamps variation.count when it exceeds axisProductSize and sets countNotice", () => {
      const state = {
        ...initialEditorState("variation"),
        variation: {
          ...initialEditorState("variation").variation,
          count: "1000",
          layout: ["headline-top"],
          tone: ["bold"],
          ratio: ["1:1"],
          background: ["procedural"],
          paletteShift: [0],
        },
        countNotice: null,
      };
      const max = axisProductSize(state);
      expect(max).toBeLessThan(1000);

      const clamped = clampPolicy(state);
      expect(clamped.variation.count).toBe(String(max));
      expect(clamped.countNotice).toBe(max);
    });

    test("leaves count unchanged and clears notice when count is within ceiling", () => {
      const state = {
        ...initialEditorState("variation"),
        variation: {
          ...initialEditorState("variation").variation,
          count: "2",
        },
        countNotice: 10,
      };
      const clamped = clampPolicy(state);
      expect(clamped.variation.count).toBe("2");
      expect(clamped.countNotice).toBeNull();
    });

    test("returns identical state when count is within ceiling and countNotice is already null", () => {
      const state = {
        ...initialEditorState("variation"),
        variation: {
          ...initialEditorState("variation").variation,
          count: "2",
        },
        countNotice: null,
      };
      const clamped = clampPolicy(state);
      expect(clamped).toBe(state);
    });

    test("treats a non-numeric count as 0 so it can never clamp above the ceiling", () => {
      const state = {
        ...initialEditorState("variation"),
        variation: {
          ...initialEditorState("variation").variation,
          count: "abc",
        },
        countNotice: null,
      };
      // parseInt("abc") → NaN → `|| 0` → 0, which is within the ceiling, so the
      // state is returned unchanged (no spurious clamp, no notice).
      const clamped = clampPolicy(state);
      expect(clamped).toBe(state);
    });
  });
});
