import { describe, test, expect } from "vitest";
import {
  DEFAULT_TREATMENT,
  LAYOUT_VALUES,
  RESERVED_CAMPAIGN_IDS,
  SAFE_ID_PATTERN,
  TONE_VALUES,
  isReservedCampaignId,
} from "../Treatment.vo.js";

describe("Treatment value object", () => {
  test("SAFE_ID_PATTERN accepts lowercase-slug ids", () => {
    for (const id of ["a", "x9", "hydra-bottle", "bold-bottom", "a".repeat(64)]) {
      expect(SAFE_ID_PATTERN.test(id), id).toBe(true);
    }
  });

  test("SAFE_ID_PATTERN rejects unsafe ids", () => {
    for (const id of [
      "",
      "Upper",
      "has space",
      "../escape",
      "a/b",
      "-leading",
      "a".repeat(65),
      "café",
    ]) {
      expect(SAFE_ID_PATTERN.test(id), id).toBe(false);
    }
  });

  test("RESERVED_CAMPAIGN_IDS lists orchestrator-reserved directory names", () => {
    expect(RESERVED_CAMPAIGN_IDS).toEqual(["cache", "jobs", "orgs", "packages"]);
  });

  test("isReservedCampaignId identifies reserved campaign ids", () => {
    for (const id of ["cache", "jobs", "orgs", "packages"]) {
      expect(isReservedCampaignId(id), id).toBe(true);
    }
    for (const id of ["camp", "my-campaign", "product", "treatment", "default"]) {
      expect(isReservedCampaignId(id), id).toBe(false);
    }
  });

  test("DEFAULT_TREATMENT is a single bold, bottom-headline treatment", () => {
    expect(DEFAULT_TREATMENT).toEqual({ id: "default", layout: "headline-bottom", tone: "bold" });
  });

  test("layout and tone value sets are the documented options", () => {
    expect(LAYOUT_VALUES).toEqual(["headline-bottom", "headline-top"]);
    expect(TONE_VALUES).toEqual(["bold", "subtle"]);
  });
});

