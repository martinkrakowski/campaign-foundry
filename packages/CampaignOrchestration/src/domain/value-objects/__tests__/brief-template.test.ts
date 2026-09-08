import { describe, test, expect } from "vitest";
import { CAMPAIGN_TYPES, CAMPAIGN_TYPE_PRESETS } from "../campaign-types.js";
import { CANONICAL_TEMPLATES } from "../creative-templates.js";
import { templateFromCanonical, type BriefTemplate } from "../brief-template.js";

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
