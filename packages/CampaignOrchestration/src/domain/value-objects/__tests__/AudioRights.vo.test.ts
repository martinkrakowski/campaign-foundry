import { describe, test, expect } from "vitest";
import {
  isAlpha2,
  normalizeRegion,
  parseExpiresOnMs,
  isExpired,
  territoryCovered,
  isAudioRights,
} from "../AudioRights.vo.js";

describe("AudioRights (VE-D8)", () => {
  describe("isAlpha2", () => {
    test("accepts two uppercase letters", () => {
      expect(isAlpha2("US")).toBe(true);
      expect(isAlpha2("FR")).toBe(true);
    });

    test("refuses lowercase, longer codes, and non-letters", () => {
      expect(isAlpha2("us")).toBe(false);
      expect(isAlpha2("USA")).toBe(false);
      expect(isAlpha2("U1")).toBe(false);
      expect(isAlpha2("")).toBe(false);
    });
  });

  describe("normalizeRegion", () => {
    test("trims and upper-cases", () => {
      expect(normalizeRegion(" us ")).toBe("US");
    });

    test("treats null/undefined as empty", () => {
      expect(normalizeRegion(null)).toBe("");
      expect(normalizeRegion(undefined)).toBe("");
    });
  });

  describe("parseExpiresOnMs", () => {
    test("parses a plain ISO date", () => {
      expect(parseExpiresOnMs("2026-01-01")).toBe(Date.parse("2026-01-01"));
    });

    test("parses an ISO date-time with an offset", () => {
      expect(parseExpiresOnMs("2026-01-01T12:00:00Z")).toBe(Date.parse("2026-01-01T12:00:00Z"));
    });

    test("refuses a non-ISO grammar Date.parse alone would accept", () => {
      expect(parseExpiresOnMs("March 3, 2026")).toBeUndefined();
    });

    test("refuses garbage", () => {
      expect(parseExpiresOnMs("not-a-date")).toBeUndefined();
      expect(parseExpiresOnMs("")).toBeUndefined();
    });
  });

  describe("isExpired", () => {
    test("strictly before is expired", () => {
      expect(isExpired(100, 200)).toBe(true);
    });

    test("equal to the instant is not expired", () => {
      expect(isExpired(100, 100)).toBe(false);
    });

    test("after the instant is not expired", () => {
      expect(isExpired(200, 100)).toBe(false);
    });
  });

  describe("territoryCovered", () => {
    test("absent territories means worldwide", () => {
      expect(territoryCovered("US", undefined)).toBe(true);
      expect(territoryCovered(null, undefined)).toBe(true);
    });

    test("member of the set is covered, normalized first", () => {
      expect(territoryCovered(" us ", ["US", "FR"])).toBe(true);
    });

    test("non-member is not covered", () => {
      expect(territoryCovered("DE", ["US", "FR"])).toBe(false);
    });
  });

  describe("isAudioRights", () => {
    test("accepts the minimal shape", () => {
      expect(isAudioRights({ licenceId: "lic-1", source: "acme" })).toBe(true);
    });

    test("accepts a full shape", () => {
      expect(
        isAudioRights({
          licenceId: "lic-1",
          source: "acme",
          expiresOn: "2026-01-01",
          territories: ["US", "FR"],
        }),
      ).toBe(true);
    });

    test("refuses non-objects", () => {
      expect(isAudioRights(null)).toBe(false);
      expect(isAudioRights("lic-1")).toBe(false);
      expect(isAudioRights(42)).toBe(false);
    });

    test("refuses a missing or empty licenceId", () => {
      expect(isAudioRights({ source: "acme" })).toBe(false);
      expect(isAudioRights({ licenceId: "", source: "acme" })).toBe(false);
    });

    test("refuses a missing or empty source", () => {
      expect(isAudioRights({ licenceId: "lic-1" })).toBe(false);
      expect(isAudioRights({ licenceId: "lic-1", source: "" })).toBe(false);
    });

    test("refuses a malformed expiresOn", () => {
      expect(isAudioRights({ licenceId: "lic-1", source: "acme", expiresOn: "not-a-date" })).toBe(false);
    });

    test("refuses an empty or non-alpha-2 territories array", () => {
      expect(isAudioRights({ licenceId: "lic-1", source: "acme", territories: [] })).toBe(false);
      expect(isAudioRights({ licenceId: "lic-1", source: "acme", territories: ["usa"] })).toBe(false);
      expect(isAudioRights({ licenceId: "lic-1", source: "acme", territories: "US" })).toBe(false);
    });
  });
});
