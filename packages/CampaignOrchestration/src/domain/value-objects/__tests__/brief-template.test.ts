import { describe, test, expect } from "vitest";
import { CAMPAIGN_TYPES, CAMPAIGN_TYPE_PRESETS } from "../campaign-types.js";
import { CANONICAL_TEMPLATES } from "../creative-templates.js";
import { isBriefTemplate, layerPropsProblem, templateFromCanonical, type BriefTemplate } from "../brief-template.js";

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

describe("isBriefTemplate layer props (L3b, D134)", () => {
  const withLayer = (layer: unknown): boolean =>
    isBriefTemplate({
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: [layer],
    });

  test("a template whose layers carry no props parses exactly as before", () => {
    expect(isBriefTemplate(templateFromCanonical("social-post"))).toBe(true);
    // A non-object layer entry stays out of the props check's scope — the same
    // leniency the `layers` array itself has always had; the API's message is
    // where a junk entry gets named.
    expect(withLayer("junk")).toBe(true);
    expect(withLayer({ id: "image", kind: "image" })).toBe(true);
  });

  test("accepts each kind's own props, and 0 and 1 are legal fractions", () => {
    expect(withLayer({ id: "shade", kind: "shade", props: {} })).toBe(true);
    expect(withLayer({ id: "shade", kind: "shade", props: { alpha: 0 } })).toBe(true);
    expect(withLayer({ id: "shade", kind: "shade", props: { alpha: 0.5 } })).toBe(true);
    expect(withLayer({ id: "shade", kind: "shade", props: { alpha: 1 } })).toBe(true);
    expect(withLayer({ id: "accent", kind: "accent", props: { solidHeight: 0.05, fadeHeight: 0 } })).toBe(true);
    expect(withLayer({ id: "logo", kind: "logo", props: { width: 0, margin: 1 } })).toBe(true);
    expect(withLayer({ id: "text", kind: "static-text", props: { anchor: "middle", typeFloor: 0.4 } })).toBe(true);
    expect(withLayer({ id: "motion", kind: "animated-text", props: { anchor: "top" } })).toBe(true);
  });

  test("refuses props on a kind that carries none, the empty object included", () => {
    expect(withLayer({ id: "image", kind: "image", props: { alpha: 0.5 } })).toBe(false);
    expect(withLayer({ id: "html", kind: "html", props: { alpha: 0.5 } })).toBe(false);
    expect(withLayer({ id: "fill", kind: "fill", props: { alpha: 0.5 } })).toBe(false);
    // The empty object names no prop, but it is still props on a kind that
    // carries none: the "must be absent" verdict is reached before any
    // entries are walked.
    expect(withLayer({ id: "video", kind: "video", props: {} })).toBe(false);
    expect(layerPropsProblem("image", {})).toEqual({
      path: "",
      must: 'be absent for layer kind "image"',
      value: {},
    });
  });

  test("refuses another kind's props (a logo carrying accent's solidHeight)", () => {
    expect(withLayer({ id: "logo", kind: "logo", props: { solidHeight: 0.05 } })).toBe(false);
  });

  test("refuses an unknown key", () => {
    expect(withLayer({ id: "shade", kind: "shade", props: { logoWidth: 0.1 } })).toBe(false);
  });

  test("refuses a number outside [0, 1]", () => {
    expect(withLayer({ id: "shade", kind: "shade", props: { alpha: 1.4 } })).toBe(false);
    expect(withLayer({ id: "logo", kind: "logo", props: { width: -0.1 } })).toBe(false);
    expect(withLayer({ id: "text", kind: "static-text", props: { typeFloor: 2 } })).toBe(false);
  });

  test("refuses a prop that is not a finite number", () => {
    expect(withLayer({ id: "shade", kind: "shade", props: { alpha: "0.5" } })).toBe(false);
    expect(withLayer({ id: "shade", kind: "shade", props: { alpha: Number.NaN } })).toBe(false);
    expect(withLayer({ id: "shade", kind: "shade", props: { alpha: Number.POSITIVE_INFINITY } })).toBe(false);
  });

  test("refuses an anchor outside the vocabulary", () => {
    expect(withLayer({ id: "text", kind: "static-text", props: { anchor: "sideways" } })).toBe(false);
    expect(withLayer({ id: "text", kind: "animated-text", props: { anchor: 5 } })).toBe(false);
  });

  test("refuses props that are not an object", () => {
    expect(withLayer({ id: "shade", kind: "shade", props: 5 })).toBe(false);
    expect(withLayer({ id: "shade", kind: "shade", props: "x" })).toBe(false);
    expect(withLayer({ id: "shade", kind: "shade", props: [1] })).toBe(false);
    expect(withLayer({ id: "shade", kind: "shade", props: null })).toBe(false);
  });

  test("refuses props on an unknown kind, while a propless unknown-kind layer stays in scope as before", () => {
    expect(withLayer({ id: "x", kind: "bogus", props: { alpha: 0.5 } })).toBe(false);
    expect(withLayer({ id: "x", kind: "bogus" })).toBe(true);
  });
});
