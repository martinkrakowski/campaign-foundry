import { describe, test, expect } from "vitest";
import { ADVERTISING_UNITS } from "../advertising-units.js";
import { CREATIVE_TYPES, CREATIVE_TYPE_RULES } from "../creative-types.js";
import {
  CANONICAL_TEMPLATES,
  CANONICAL_TEMPLATE_IDS,
  type CanonicalTemplateId,
} from "../creative-templates.js";

describe("canonical creative templates (D123, D128)", () => {
  test("canonical template IDs tuple matches known identifiers", () => {
    expect(CANONICAL_TEMPLATE_IDS).toEqual([
      "canonical-image-text",
      "canonical-image-html",
      "canonical-video",
    ]);
  });

  test("the canonical template id union is compile-locked", () => {
    const ids: readonly CanonicalTemplateId[] = CANONICAL_TEMPLATE_IDS;
    expect(ids).toHaveLength(3);
  });

  test("every CREATIVE_TYPES member has a canonical template keyed by its type", () => {
    expect(Object.keys(CANONICAL_TEMPLATES).sort()).toEqual([...CREATIVE_TYPES].sort());
  });

  test("every template entry has version 1 and a non-empty name", () => {
    for (const template of Object.values(CANONICAL_TEMPLATES)) {
      expect(template.version).toBe(1);
      expect(typeof template.name).toBe("string");
      expect(template.name.length).toBeGreaterThan(0);
    }
  });

  test("every CANONICAL_TEMPLATES entry's creativeType matches its key, its unit is an ADVERTISING_UNITS member, and every layer kind is in that type's accepts", () => {
    const validUnits = new Set<string>(ADVERTISING_UNITS);
    for (const [key, template] of Object.entries(CANONICAL_TEMPLATES)) {
      expect(template.creativeType).toBe(key);
      expect(validUnits.has(template.unit)).toBe(true);

      const rule = CREATIVE_TYPE_RULES[template.creativeType];
      const acceptedKinds = new Set(rule.accepts);

      for (const layer of template.layers) {
        expect(
          acceptedKinds.has(layer.kind),
          `canonical template "${template.id}" holds layer kind "${layer.kind}" which is refused by ${template.creativeType}'s rule`,
        ).toBe(true);
      }
    }
  });

  test("every canonical template contains every required kind of its type", () => {
    for (const template of Object.values(CANONICAL_TEMPLATES)) {
      const rule = CREATIVE_TYPE_RULES[template.creativeType];
      const templateKinds = new Set(template.layers.map((l) => l.kind));

      for (const req of rule.required) {
        expect(
          templateKinds.has(req),
          `canonical template "${template.id}" is missing required layer kind "${req}"`,
        ).toBe(true);
      }
    }
  });

  test("layer ids are unique within a template", () => {
    for (const template of Object.values(CANONICAL_TEMPLATES)) {
      const ids = template.layers.map((l) => l.id);
      const uniqueIds = new Set(ids);
      expect(
        uniqueIds.size,
        `duplicate layer ids found in template "${template.id}"`,
      ).toBe(ids.length);
    }
  });

  test("the image-text canonical template's kind order is exactly ['image','shade','accent','static-text','logo'] (pins D128 and compositor draw order)", () => {
    const kinds = CANONICAL_TEMPLATES["image-text"].layers.map((l) => l.kind);
    expect(kinds).toEqual(["image", "shade", "accent", "static-text", "logo"]);
  });
});
