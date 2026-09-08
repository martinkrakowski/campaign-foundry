import { describe, test, expect } from "vitest";
import {
  BRIEF_SCHEMA_VERSION,
  isSupportedBriefSchemaVersion,
} from "../brief-schema-version.js";

describe("brief schema version (D133)", () => {
  test("BRIEF_SCHEMA_VERSION is 1", () => {
    expect(BRIEF_SCHEMA_VERSION).toBe(1);
  });

  test("isSupportedBriefSchemaVersion boundaries: 0 false, 1 true, 2 false, 1.5 false", () => {
    expect(isSupportedBriefSchemaVersion(0)).toBe(false);
    expect(isSupportedBriefSchemaVersion(1)).toBe(true);
    expect(isSupportedBriefSchemaVersion(2)).toBe(false);
    expect(isSupportedBriefSchemaVersion(1.5)).toBe(false);
    expect(isSupportedBriefSchemaVersion(-1)).toBe(false);
  });

  test("isSupportedBriefSchemaVersion rejects non-integers and non-numbers", () => {
    expect(isSupportedBriefSchemaVersion("1")).toBe(false);
    expect(isSupportedBriefSchemaVersion(null)).toBe(false);
    expect(isSupportedBriefSchemaVersion(undefined)).toBe(false);
    expect(isSupportedBriefSchemaVersion({})).toBe(false);
    expect(isSupportedBriefSchemaVersion([])).toBe(false);
    expect(isSupportedBriefSchemaVersion(true)).toBe(false);
    expect(isSupportedBriefSchemaVersion(NaN)).toBe(false);
    expect(isSupportedBriefSchemaVersion(Infinity)).toBe(false);
  });
});
