import { describe, test, expect } from "vitest";
import {
  DEFAULT_TREATMENT,
  LAYOUT_VALUES,
  SAFE_ID_PATTERN,
  TONE_VALUES,
} from "../Treatment.vo.js";

describe("Treatment value object", () => {
  test("SAFE_ID_PATTERN accepts lowercase-slug ids", () => {
    for (const id of ["a", "x9", "hydra-bottle", "bold-bottom", "a".repeat(64)]) {
      expect(SAFE_ID_PATTERN.test(id), id).toBe(true);
    }
  });

  test("SAFE_ID_PATTERN rejects unsafe ids", () => {
    for (const id of ["", "Upper", "has space", "../escape", "a/b", "-leading", "a".repeat(65), "café"]) {
      expect(SAFE_ID_PATTERN.test(id), id).toBe(false);
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
