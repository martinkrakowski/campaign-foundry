import { describe, test, expect } from "vitest";
import { CAMPAIGN_TYPES, CAMPAIGN_TYPE_PRESETS } from "../campaign-types.js";
import { CANONICAL_TEMPLATES } from "../creative-templates.js";
import { isBriefTemplate, templateFromCanonical, type BriefTemplate } from "../brief-template.js";

describe("BriefTemplate and templateFromCanonical (D120, D123, D128)", () => {
  test("templateFromCanonical returns the preset's template for all four campaign types", () => {
    for (const type of CAMPAIGN_TYPES) {
      const preset = CAMPAIGN_TYPE_PRESETS[type];
      const canonical = CANONICAL_TEMPLATES[preset.creativeType];
      const template: BriefTemplate = templateFromCanonical(type);

      expect(template.id).toBe(preset.template);
      expect(template.version).toBe(canonical.version);
      expect(template.creativeType).toBe(preset.creativeType);
      expect(template.unit).toBe(preset.unit);
      expect(template.layers).toEqual(canonical.layers);
      expect(template.layers.length).toBeGreaterThan(0);
    }
  });

  test("social-post resolves to canonical-image-text with 5 layers in z-order", () => {
    const template = templateFromCanonical("social-post");
    expect(template).toEqual({
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: [
        { id: "image", kind: "image" },
        { id: "shade", kind: "shade" },
        { id: "accent", kind: "accent" },
        { id: "static-text", kind: "static-text" },
        { id: "logo", kind: "logo" },
      ],
    });
  });

  test("paid-social resolves to canonical-image-text with 5 layers in z-order", () => {
    const template = templateFromCanonical("paid-social");
    expect(template.id).toBe("canonical-image-text");
    expect(template.creativeType).toBe("image-text");
    expect(template.layers).toHaveLength(5);
  });

  test("short-video resolves to canonical-video with 4 layers in z-order", () => {
    const template = templateFromCanonical("short-video");
    expect(template).toEqual({
      id: "canonical-video",
      version: 1,
      creativeType: "video",
      unit: "standard-web",
      layers: [
        { id: "video", kind: "video" },
        { id: "shade", kind: "shade" },
        { id: "animated-text", kind: "animated-text" },
        { id: "logo", kind: "logo" },
      ],
    });
  });

  test("display-ad resolves to canonical-image-text with 5 layers in z-order", () => {
    const template = templateFromCanonical("display-ad");
    expect(template.id).toBe("canonical-image-text");
    expect(template.creativeType).toBe("image-text");
    expect(template.layers).toHaveLength(5);
  });
});

describe("isBriefTemplate (L3a)", () => {
  test("accepts a full canonical template for every campaign type", () => {
    for (const type of CAMPAIGN_TYPES) {
      expect(isBriefTemplate(templateFromCanonical(type))).toBe(true);
    }
  });

  test("refuses anything that is not a plain object", () => {
    expect(isBriefTemplate("not-an-object")).toBe(false);
    expect(isBriefTemplate(42)).toBe(false);
    expect(isBriefTemplate(true)).toBe(false);
    expect(isBriefTemplate(null)).toBe(false);
    expect(isBriefTemplate([])).toBe(false);
  });

  test("refuses a template whose id is not a canonical member", () => {
    expect(isBriefTemplate({ id: 42, version: 1, creativeType: "video", unit: "standard-web", layers: [] })).toBe(false);
    expect(
      isBriefTemplate({ id: "nope", version: 1, creativeType: "video", unit: "standard-web", layers: [] }),
    ).toBe(false);
  });

  test("refuses a template whose version is not a positive integer", () => {
    // Canonical id and an array `layers`, but nothing after them: the minimal
    // shape ({ id, layers }) is not the five-field contract — the API would
    // refuse the brief it let through.
    expect(isBriefTemplate({ id: "canonical-image-text", layers: [] })).toBe(false);
    expect(
      isBriefTemplate({ id: "canonical-video", version: 1.5, creativeType: "video", unit: "standard-web", layers: [] }),
    ).toBe(false);
    expect(
      isBriefTemplate({ id: "canonical-video", version: 0, creativeType: "video", unit: "standard-web", layers: [] }),
    ).toBe(false);
  });

  test("refuses a template whose creativeType is not a member", () => {
    expect(isBriefTemplate({ id: "canonical-video", version: 1, layers: [] })).toBe(false);
    expect(
      isBriefTemplate({ id: "canonical-video", version: 1, creativeType: "bogus", unit: "standard-web", layers: [] }),
    ).toBe(false);
  });

  test("refuses a template whose unit is not a member", () => {
    expect(isBriefTemplate({ id: "canonical-video", version: 1, creativeType: "video", layers: [] })).toBe(false);
    expect(
      isBriefTemplate({ id: "canonical-video", version: 1, creativeType: "video", unit: "bogus", layers: [] }),
    ).toBe(false);
  });

  test("refuses a template whose layers are not an array", () => {
    expect(isBriefTemplate({ id: "canonical-video", version: 1, creativeType: "video", unit: "standard-web" })).toBe(false);
    expect(
      isBriefTemplate({ id: "canonical-video", version: 1, creativeType: "video", unit: "standard-web", layers: "no" }),
    ).toBe(false);
  });

  test("checks shape, never content: a reordered layer list is still a valid template", () => {
    const canonical = templateFromCanonical("social-post");
    const reordered = { ...canonical, layers: [...canonical.layers].reverse() };
    expect(isBriefTemplate(reordered)).toBe(true);
  });
});
