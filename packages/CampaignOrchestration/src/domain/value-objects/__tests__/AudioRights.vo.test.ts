import { describe, test, expect } from "vitest";
import {
  isAlpha2,
  normalizeRegion,
  parseExpiresOnMs,
  isExpired,
  territoryCovered,
  isAudioRights,
  isAudio,
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

    test("refuses the ISO 3166-1 user-assigned codes (VE-D8 fix2 #4)", () => {
      expect(isAlpha2("AA")).toBe(false);
      expect(isAlpha2("ZZ")).toBe(false);
      expect(isAlpha2("QM")).toBe(false);
      expect(isAlpha2("QZ")).toBe(false);
      expect(isAlpha2("QT")).toBe(false);
      expect(isAlpha2("XA")).toBe(false);
      expect(isAlpha2("XZ")).toBe(false);
      expect(isAlpha2("XK")).toBe(false);
    });

    test("does not over-refuse real assigned codes that share a letter with a reserved range", () => {
      expect(isAlpha2("QA")).toBe(true); // Qatar — real, assigned, outside QM-QZ.
      expect(isAlpha2("ZA")).toBe(true); // South Africa — real, not ZZ.
      expect(isAlpha2("AZ")).toBe(true); // Azerbaijan — real, not AA.
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
    test("a plain ISO date is valid through the end of that UTC day (VE-D8 fix2 #1)", () => {
      expect(parseExpiresOnMs("2026-01-01")).toBe(Date.UTC(2026, 0, 1, 23, 59, 59, 999));
    });

    test("parses an ISO date-time with a Z offset", () => {
      expect(parseExpiresOnMs("2026-01-01T12:00:00Z")).toBe(Date.parse("2026-01-01T12:00:00Z"));
    });

    test("parses an ISO date-time with an explicit numeric offset", () => {
      expect(parseExpiresOnMs("2026-01-01T12:00:00+05:00")).toBe(
        Date.parse("2026-01-01T12:00:00+05:00"),
      );
    });

    test("refuses a date-time with no Z/offset (VE-D8 fix2 #1) — no local-time fallback", () => {
      // Date.parse alone reads this as the host's local time; there is no
      // correct instant to assign it, so it is refused outright, not coerced.
      expect(parseExpiresOnMs("2026-01-01T12:00:00")).toBeUndefined();
      expect(parseExpiresOnMs("2026-01-01T12:00:00.500")).toBeUndefined();
    });

    test("refuses an impossible calendar date, date-only (VE-D8 fix2 #2)", () => {
      expect(parseExpiresOnMs("2026-02-30")).toBeUndefined();
      expect(parseExpiresOnMs("2026-04-31")).toBeUndefined();
      expect(parseExpiresOnMs("2026-00-10")).toBeUndefined();
      expect(parseExpiresOnMs("2026-01-00")).toBeUndefined();
    });

    test("refuses an impossible calendar date, date-time with offset (VE-D8 fix2 #2)", () => {
      expect(parseExpiresOnMs("2026-02-30T12:00:00Z")).toBeUndefined();
    });

    test("accepts a real leap-day and refuses a non-leap-year Feb 29", () => {
      expect(parseExpiresOnMs("2028-02-29")).toBe(Date.UTC(2028, 1, 29, 23, 59, 59, 999));
      expect(parseExpiresOnMs("2026-02-29")).toBeUndefined();
    });

    test("refuses a non-ISO grammar Date.parse alone would accept", () => {
      expect(parseExpiresOnMs("March 3, 2026")).toBeUndefined();
    });

    test("refuses an out-of-range time component on an otherwise valid calendar date", () => {
      // A valid Y-M-D with an impossible hour/minute/second: the regex shape and the
      // calendar-date check both pass, but Date.parse itself refuses the instant.
      expect(parseExpiresOnMs("2026-01-01T25:00:00Z")).toBeUndefined();
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
      expect(isAudioRights({ licenceId: "lic-1", source: "acme", expiresOn: "not-a-date" })).toBe(
        false,
      );
    });

    test("refuses an empty or non-alpha-2 territories array", () => {
      expect(isAudioRights({ licenceId: "lic-1", source: "acme", territories: [] })).toBe(false);
      expect(isAudioRights({ licenceId: "lic-1", source: "acme", territories: ["usa"] })).toBe(
        false,
      );
      expect(isAudioRights({ licenceId: "lic-1", source: "acme", territories: "US" })).toBe(false);
    });

    test("refuses a user-assigned territory code (VE-D8 fix2 #4)", () => {
      expect(isAudioRights({ licenceId: "lic-1", source: "acme", territories: ["ZZ"] })).toBe(
        false,
      );
    });
  });

  describe("isAudio (VE3a fix3)", () => {
    test("accepts a minimal well-formed block", () => {
      expect(isAudio({ path: "a.mp3", rights: { licenceId: "lic-1", source: "acme" } })).toBe(true);
    });

    test("accepts a full well-formed block", () => {
      expect(
        isAudio({
          path: "a.mp3",
          rights: {
            licenceId: "lic-1",
            source: "acme",
            expiresOn: "2026-01-01",
            territories: ["US"],
          },
        }),
      ).toBe(true);
    });

    test("refuses non-objects, null, and arrays", () => {
      expect(isAudio(null)).toBe(false);
      expect(isAudio("a.mp3")).toBe(false);
      expect(isAudio(42)).toBe(false);
      expect(isAudio([])).toBe(false);
    });

    test("refuses a missing or empty path", () => {
      expect(isAudio({ rights: { licenceId: "lic-1", source: "acme" } })).toBe(false);
      expect(isAudio({ path: "", rights: { licenceId: "lic-1", source: "acme" } })).toBe(false);
      expect(isAudio({ path: 5, rights: { licenceId: "lic-1", source: "acme" } })).toBe(false);
    });

    test("refuses a missing, null, or non-object rights", () => {
      expect(isAudio({ path: "a.mp3" })).toBe(false);
      expect(isAudio({ path: "a.mp3", rights: null })).toBe(false);
      expect(isAudio({ path: "a.mp3", rights: [] })).toBe(false);
      expect(isAudio({ path: "a.mp3", rights: "lic-1" })).toBe(false);
    });

    test("refuses empty rights or a missing licenceId (VE3a fix3)", () => {
      expect(isAudio({ path: "a.mp3", rights: {} })).toBe(false);
      expect(isAudio({ path: "a.mp3", rights: { source: "acme" } })).toBe(false);
    });

    test("refuses an unknown key on audio or on rights (VE3a fix3)", () => {
      expect(
        isAudio({ path: "a.mp3", rights: { licenceId: "lic-1", source: "acme" }, track: "extra" }),
      ).toBe(false);
      expect(
        isAudio({ path: "a.mp3", rights: { licenceId: "lic-1", source: "acme", track: "extra" } }),
      ).toBe(false);
    });

    test("refuses an impossible expiresOn (VE3a fix3)", () => {
      expect(
        isAudio({
          path: "a.mp3",
          rights: { licenceId: "lic-1", source: "acme", expiresOn: "2024-02-30" },
        }),
      ).toBe(false);
    });
  });
});
