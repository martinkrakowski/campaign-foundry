import { describe, test, expect } from "vitest";
import { ADVERTISING_UNITS } from "../advertising-units.js";
import { LAYER_KINDS } from "../layer-kinds.js";
import {
  CREATIVE_TYPES,
  CREATIVE_TYPE_RULES,
  type CreativeType,
} from "../creative-types.js";

describe("creative types and compatibility rules (D119, D124, D131)", () => {
  test("the vocabulary is exactly the three creative types", () => {
    expect(CREATIVE_TYPES).toEqual(["image-text", "image-html", "video"]);
  });

  test("the union is compile-locked", () => {
    const types: readonly CreativeType[] = CREATIVE_TYPES;
    expect(types).toHaveLength(3);
  });

  test("every CREATIVE_TYPE_RULES key is a CREATIVE_TYPES member and vice versa", () => {
    expect(Object.keys(CREATIVE_TYPE_RULES).sort()).toEqual([...CREATIVE_TYPES].sort());
  });

  test("every kind in every accepts and required list is a LAYER_KINDS member", () => {
    const validKinds = new Set<string>(LAYER_KINDS);
    for (const [type, rule] of Object.entries(CREATIVE_TYPE_RULES)) {
      for (const kind of rule.accepts) {
        expect(
          validKinds.has(kind),
          `creative type "${type}" accepts unknown layer kind "${kind}"`,
        ).toBe(true);
      }
      for (const kind of rule.required) {
        expect(
          validKinds.has(kind),
          `creative type "${type}" requires unknown layer kind "${kind}"`,
        ).toBe(true);
      }
    }
  });

  test("required is a subset of accepts for every type", () => {
    for (const [type, rule] of Object.entries(CREATIVE_TYPE_RULES)) {
      const acceptsSet = new Set(rule.accepts);
      for (const req of rule.required) {
        expect(
          acceptsSet.has(req),
          `creative type "${type}" marks "${req}" required but does not accept it`,
        ).toBe(true);
      }
    }
  });

  test("fill is accepted by no creative type (pins D131)", () => {
    for (const [type, rule] of Object.entries(CREATIVE_TYPE_RULES)) {
      expect(
        rule.accepts.includes("fill"),
        `creative type "${type}" must not accept "fill" until L11 (D131)`,
      ).toBe(false);
    }
  });

  test("every rule names a valid advertising unit and valid, non-empty, duplicate-free output families", () => {
    const validUnits = new Set<string>(ADVERTISING_UNITS);
    const validFamilies = new Set(["static", "motion", "html"]);
    for (const [type, rule] of Object.entries(CREATIVE_TYPE_RULES)) {
      expect(validUnits.has(rule.unit)).toBe(true);
      expect(rule.outputFamilies.length, `outputFamilies for ${type} must be non-empty`).toBeGreaterThan(0);
      expect(
        new Set(rule.outputFamilies).size,
        `outputFamilies for ${type} must not contain duplicates`,
      ).toBe(rule.outputFamilies.length);
      for (const family of rule.outputFamilies) {
        expect(
          validFamilies.has(family),
          `creative type "${type}" names unknown output family "${family}"`,
        ).toBe(true);
      }
    }
  });

  test("rules match the plan's §2.1 compatibility table exactly", () => {
    expect(CREATIVE_TYPE_RULES["image-text"]).toEqual({
      unit: "standard-web",
      accepts: ["image", "shade", "accent", "static-text", "animated-text", "logo"],
      required: ["image", "static-text"],
      maxOf: { logo: 1, shade: 1, accent: 1 },
      sharedBudgets: [{ kinds: ["static-text", "animated-text"], max: 1 }],
      outputFamilies: ["static", "motion"],
    });

    expect(CREATIVE_TYPE_RULES["image-html"]).toEqual({
      unit: "standard-web",
      accepts: ["image", "html", "logo"],
      required: ["image", "html"],
      maxOf: { logo: 1 },
      outputFamilies: ["html"],
    });

    expect(CREATIVE_TYPE_RULES["video"]).toEqual({
      unit: "standard-web",
      accepts: ["video", "shade", "animated-text", "logo"],
      required: ["video"],
      maxOf: { logo: 1, shade: 1 },
      outputFamilies: ["motion"],
    });
  });
});
