import { describe, test, expect } from "vitest";
import { CAMPAIGN_TYPES, CAMPAIGN_TYPE_PRESETS } from "../campaign-types.js";
import { CANONICAL_TEMPLATES } from "../creative-templates.js";
import type { LayerKind } from "../layer-kinds.js";
import {
  isBriefTemplate,
  layerEnabledProblem,
  layerPropsProblem,
  satisfiesOrderConstraints,
  templateFromCanonical,
  type BriefTemplate,
} from "../brief-template.js";

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

  test("canonical templates in CANONICAL_TEMPLATES all satisfy their own type's constraints (D128)", () => {
    for (const [type, template] of Object.entries(CANONICAL_TEMPLATES)) {
      expect(
        satisfiesOrderConstraints(template.creativeType, template.layers),
        `canonical template "${type}" violates its own type's constraints`,
      ).toBe(true);
      expect(isBriefTemplate(template)).toBe(true);
    }
  });

  test("an obeying layer order is accepted by isBriefTemplate (D128)", () => {
    const canonical = templateFromCanonical("social-post");
    // Swap accent (index 2) and static-text (index 3):
    // [image, shade, static-text, accent, logo]
    // shade is still directly above image (0 -> 1), logo is still above image (0 -> 4).
    const obeying = {
      ...canonical,
      layers: [
        canonical.layers[0]!,
        canonical.layers[1]!,
        canonical.layers[3]!,
        canonical.layers[2]!,
        canonical.layers[4]!,
      ],
    };
    expect(isBriefTemplate(obeying)).toBe(true);
  });

  test("a violating layer order is refused by isBriefTemplate (D128)", () => {
    const canonical = templateFromCanonical("social-post");
    // 1. Reversed canonical: logo below image, shade not directly above image
    const reversed = { ...canonical, layers: [...canonical.layers].reverse() };
    expect(isBriefTemplate(reversed)).toBe(false);

    // 2. Logo below image: [logo, image, shade, accent, static-text]
    const logoBelowImage = {
      ...canonical,
      layers: [
        canonical.layers[4]!, // logo
        canonical.layers[0]!, // image
        canonical.layers[1]!, // shade
        canonical.layers[2]!, // accent
        canonical.layers[3]!, // static-text
      ],
    };
    expect(isBriefTemplate(logoBelowImage)).toBe(false);

    // 3. Shade not directly above image (accent between image and shade):
    // [image, accent, shade, static-text, logo]
    const shadeNotDirectlyAbove = {
      ...canonical,
      layers: [
        canonical.layers[0]!, // image
        canonical.layers[2]!, // accent
        canonical.layers[1]!, // shade
        canonical.layers[3]!, // static-text
        canonical.layers[4]!, // logo
      ],
    };
    expect(isBriefTemplate(shadeNotDirectlyAbove)).toBe(false);

    // 4. Shade below image: [shade, image, accent, static-text, logo]
    const shadeBelowImage = {
      ...canonical,
      layers: [
        canonical.layers[1]!, // shade
        canonical.layers[0]!, // image
        canonical.layers[2]!, // accent
        canonical.layers[3]!, // static-text
        canonical.layers[4]!, // logo
      ],
    };
    expect(isBriefTemplate(shadeBelowImage)).toBe(false);
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
    expect(withLayer({ id: "image", kind: "image" })).toBe(true);
  });

  test("refuses a layers entry that is not a layer (L5)", () => {
    // The per-layer guard is the one check a stored draft's entries face, so it
    // carries the whole entry contract: `countKinds` dereferences `layer.kind`
    // the moment a corrupt draft's section mounts, and `null` — which used to
    // pass as "no props problem" — has no kind to read. A layer that is not a
    // non-null, non-array object with a string id and a vocabulary kind is not
    // a layer, whatever else it may be.
    expect(withLayer(null)).toBe(false);
    expect(withLayer("junk")).toBe(false);
    expect(withLayer(42)).toBe(false);
    expect(withLayer([{ id: "image", kind: "image" }])).toBe(false);
    expect(withLayer({})).toBe(false);
    expect(withLayer({ id: "image" })).toBe(false);
    expect(withLayer({ kind: "image" })).toBe(false);
    expect(withLayer({ id: 42, kind: "image" })).toBe(false);
  });

  test("refuses a layers entry whose kind is outside the vocabulary (L5)", () => {
    // A kind the vocabulary does not name is as dereference-hostile as a
    // missing one: the editor's add/remove offers and the API's compatibility
    // table both read the kind against their own vocabularies.
    expect(withLayer({ id: "x", kind: "bogus" })).toBe(false);
    expect(withLayer({ id: "x", kind: "bogus", props: { alpha: 0.5 } })).toBe(false);
  });

  test("refuses duplicate layer ids, the rule the API already applies (L5)", () => {
    const layer = { id: "shade", kind: "shade" as const };
    expect(
      isBriefTemplate({
        id: "canonical-image-text",
        version: 1,
        creativeType: "image-text",
        unit: "standard-web",
        layers: [layer, { ...layer }],
      }),
    ).toBe(false);
    // The ids clash even when the kinds differ — the id is the row's identity,
    // and one remove click must name exactly one row.
    expect(
      isBriefTemplate({
        id: "canonical-image-text",
        version: 1,
        creativeType: "image-text",
        unit: "standard-web",
        layers: [layer, { id: "shade", kind: "logo" }],
      }),
    ).toBe(false);
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

  test("refuses props on an unknown kind directly — the shared decision, not the guard's kind check", () => {
    // `layerPropsProblem` is the per-kind props decision both boundaries read;
    // the entry guard checks the kind *before* reaching it, so this branch is
    // the function's own contract, exercised directly (the API calls it after
    // its own `accepts` check, never with an unknown kind).
    expect(layerPropsProblem("bogus" as LayerKind, { alpha: 0.5 })).toEqual({
      path: "",
      must: 'be absent for layer kind "bogus"',
      value: { alpha: 0.5 },
    });
    expect(layerPropsProblem("bogus" as LayerKind, {})).toEqual({
      path: "",
      must: 'be absent for layer kind "bogus"',
      value: {},
    });
  });
});

describe("isBriefTemplate layer enabled (D129)", () => {
  const withLayer = (layer: unknown): boolean =>
    isBriefTemplate({
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: [layer],
    });

  test("accepts a layer without enabled (absent means enabled)", () => {
    expect(withLayer({ id: "image", kind: "image" })).toBe(true);
  });

  test("accepts a layer with enabled: true and enabled: false", () => {
    expect(withLayer({ id: "shade", kind: "shade", enabled: true })).toBe(true);
    expect(withLayer({ id: "shade", kind: "shade", enabled: false })).toBe(true);
  });

  test("refuses a layer with non-boolean enabled (e.g. string 'yes', number 1)", () => {
    expect(withLayer({ id: "shade", kind: "shade", enabled: "yes" })).toBe(false);
    expect(withLayer({ id: "shade", kind: "shade", enabled: "true" })).toBe(false);
    expect(withLayer({ id: "shade", kind: "shade", enabled: 1 })).toBe(false);
    expect(withLayer({ id: "shade", kind: "shade", enabled: 0 })).toBe(false);
    expect(withLayer({ id: "shade", kind: "shade", enabled: null })).toBe(false);
    expect(withLayer({ id: "shade", kind: "shade", enabled: {} })).toBe(false);
  });

  test("layerEnabledProblem returns undefined for boolean and undefined, problem for non-boolean", () => {
    expect(layerEnabledProblem(undefined)).toBeUndefined();
    expect(layerEnabledProblem(true)).toBeUndefined();
    expect(layerEnabledProblem(false)).toBeUndefined();
    expect(layerEnabledProblem("yes")).toEqual({
      field: "enabled",
      must: "be a boolean",
      value: "yes",
    });
    expect(layerEnabledProblem(1)).toEqual({
      field: "enabled",
      must: "be a boolean",
      value: 1,
    });
    expect(layerEnabledProblem(null)).toEqual({
      field: "enabled",
      must: "be a boolean",
      value: null,
    });
  });
});

describe("isBriefTemplate layer elements (HL1)", () => {
  const frame = { x: 0.1, y: 0.2, w: 0.5, h: 0.3, anchor: "top" as const };

  /** An image-html template with `elements` swapped onto its html layer. */
  const withElements = (elements: unknown): boolean =>
    isBriefTemplate({
      id: "canonical-image-html",
      version: 1,
      creativeType: "image-html",
      unit: "standard-web",
      layers: [
        { id: "image", kind: "image" },
        { id: "html", kind: "html", elements },
        { id: "logo", kind: "logo" },
      ],
    });

  test("accepts an html layer carrying each element kind, and absent or empty elements", () => {
    expect(withElements(undefined)).toBe(true);
    expect(withElements([])).toBe(true);
    expect(
      withElements([
        { kind: "text", text: "Buy now", frame },
        { kind: "button", text: "Shop", frame },
        { kind: "image", frame },
      ]),
    ).toBe(true);
  });

  test("refuses elements on a layer that is not html", () => {
    expect(
      isBriefTemplate({
        id: "canonical-image-html",
        version: 1,
        creativeType: "image-html",
        unit: "standard-web",
        layers: [
          { id: "image", kind: "image", elements: [] },
          { id: "html", kind: "html" },
          { id: "logo", kind: "logo" },
        ],
      }),
    ).toBe(false);
  });

  test("refuses a malformed element — an unknown kind, a non-string copy, a bad frame", () => {
    expect(withElements([{ kind: "link", text: "x", frame }])).toBe(false);
    expect(withElements([{ kind: "text", text: 5, frame }])).toBe(false);
    expect(withElements([{ kind: "text", text: "x", frame: { ...frame, x: 2 } }])).toBe(false);
    expect(withElements([{ kind: "image", text: "x", frame }])).toBe(false);
  });
});

