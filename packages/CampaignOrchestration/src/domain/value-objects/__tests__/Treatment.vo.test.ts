import { describe, test, expect } from "vitest";
import {
  DEFAULT_TREATMENT,
  LAYOUT_VALUES,
  RESERVED_CAMPAIGN_IDS,
  SAFE_ID_PATTERN,
  TONE_VALUES,
  isReservedCampaignId,
  slugify,
} from "../Treatment.vo.js";

/**
 * The web's own copy (`apps/web/src/components/campaign/editor-state.ts:220`),
 * pasted rather than imported — a package test importing app code would
 * invert the dependency direction `yarn lint:arch` enforces. Parity, like
 * #611's `RESERVED_CAMPAIGN_IDS` test, means both copies are pinned against
 * the SAME fixed cases below, so a future edit to either one that drifts from
 * these expectations fails here first.
 */
function webSlugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

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

  test("RESERVED_CAMPAIGN_IDS lists orchestrator-reserved campaign ids", () => {
    expect(RESERVED_CAMPAIGN_IDS).toEqual(["cache", "jobs", "last-opened", "orgs", "packages"]);
  });

  test("isReservedCampaignId identifies reserved campaign ids", () => {
    for (const id of ["cache", "jobs", "last-opened", "orgs", "packages"]) {
      expect(isReservedCampaignId(id), id).toBe(true);
    }
    for (const id of ["camp", "my-campaign", "product", "treatment", "default", "last-opened-2"]) {
      expect(isReservedCampaignId(id), id).toBe(false);
    }
  });

  test("`last-opened` is reserved because the static route of that name would shadow a campaign's own id (PT-5e, D180)", () => {
    // The reserved list is what stops `slugify("Last Opened")` from minting the
    // very path `/campaigns/last-opened` addresses (D179: on fs the slug IS the
    // campaign's only id, so the shadowing would cost it its `GET /campaigns/:id`).
    expect(slugify("Last Opened")).toBe("last-opened");
    expect(isReservedCampaignId(slugify("Last Opened"))).toBe(true);
  });

  test("slugify equals the web's mirror (parity, pinned against drift)", () => {
    const cases = [
      "My Campaign",
      "  leading and trailing  ",
      "Ünïcödé Bräñd",
      "already-a-slug",
      "UPPER_CASE!!",
      "a".repeat(70),
      "----",
      "",
      "a".repeat(62) + "--",
    ];
    for (const value of cases) {
      expect(slugify(value), value).toBe(webSlugify(value));
    }
  });

  test("slugify lowercases, collapses non-alphanumerics to one hyphen, and trims", () => {
    expect(slugify("My Campaign")).toBe("my-campaign");
    expect(slugify("  --Weird__Name!!--  ")).toBe("weird-name");
    expect(slugify("Ünïcödé")).toBe("n-c-d");
  });

  test("slugify caps at 64 characters and re-trims the hyphen the cut exposes", () => {
    // 63 "a"s then a hyphen land exactly at index 63 (the 64th character);
    // slicing to 64 chars keeps that hyphen as the new last character, which
    // the final `.replace(/-+$/, "")` must remove.
    const long = `${"a".repeat(63)}-rest`;
    expect(long.slice(0, 64).endsWith("-")).toBe(true);
    expect(slugify(long)).toBe("a".repeat(63));
    expect(slugify(long)).toBe(webSlugify(long));
  });

  test("slugify answers empty for a name with no letter or digit", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("   ")).toBe("");
  });

  test("DEFAULT_TREATMENT is a single bold, bottom-headline treatment", () => {
    expect(DEFAULT_TREATMENT).toEqual({ id: "default", layout: "headline-bottom", tone: "bold" });
  });

  test("layout and tone value sets are the documented options", () => {
    expect(LAYOUT_VALUES).toEqual(["headline-bottom", "headline-top"]);
    expect(TONE_VALUES).toEqual(["bold", "subtle"]);
  });
});
