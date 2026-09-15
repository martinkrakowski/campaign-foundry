import { describe, test, expect } from "vitest";
import { CAMPAIGN_TYPES, CAMPAIGN_TYPE_PRESETS } from "../campaign-types.js";
import { CANONICAL_TEMPLATES } from "../creative-templates.js";
import type { CreativeType } from "../creative-types.js";
import type { LayerKind } from "../layer-kinds.js";
import {
  isBriefTemplate,
  layerEnabledProblem,
  layerPropsProblem,
  satisfiesOrderConstraints,
  templateFromCanonical,
  templateHasAnchorProp,
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
  /**
   * X11 tightened the guard: a template must carry its type's required kinds
   * and only its type's accepted kinds, so the layer under test REPLACES the
   * canonical layer of its kind on a full template of the given type (or joins
   * the list when that canonical carries no such kind) — the props decision
   * under test stays the only thing that can refuse the template.
   */
  const withLayer = (
    layer: unknown,
    creativeType: CreativeType = "image-text",
  ): boolean => {
    const kind = (layer as { kind?: unknown } | null)?.kind;
    const canonical = CANONICAL_TEMPLATES[creativeType].layers;
    return isBriefTemplate({
      id: CANONICAL_TEMPLATES[creativeType].id,
      version: 1,
      creativeType,
      unit: "standard-web",
      layers:
        typeof kind === "string" && canonical.some((l) => l.kind === kind)
          ? canonical.map((l) => (l.kind === kind ? layer : l))
          : [...canonical, layer],
    });
  };

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
    // X11 made the rest of the template load-bearing, so the duplicates ride a
    // full canonical list: uniqueness is the only rule each draft can fail.
    // An extra layer wearing the bottom image's id — no cap or budget for
    // `image`, order still obeyed — is refused for the id alone.
    const canonical = CANONICAL_TEMPLATES["image-text"].layers;
    expect(
      isBriefTemplate({
        id: "canonical-image-text",
        version: 1,
        creativeType: "image-text",
        unit: "standard-web",
        layers: [{ id: "image", kind: "image" }, ...canonical],
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
        layers: canonical.map((l) =>
          l.kind === "accent" ? { id: "image", kind: "accent" } : l,
        ),
      }),
    ).toBe(false);
  });

  test("accepts each kind's own props, and 0 and 1 are legal fractions", () => {
    expect(withLayer({ id: "accent", kind: "accent", props: { solidHeight: 0.05, fadeHeight: 0 } })).toBe(true);
    expect(withLayer({ id: "logo", kind: "logo", props: { width: 0, margin: 1 } })).toBe(true);
    expect(withLayer({ id: "text", kind: "static-text", props: { anchor: "middle", typeFloor: 0.4 } })).toBe(true);
    // animated-text shares image-text's text budget with static-text (D124),
    // so the video type's canonical carries it: the kind's own props against
    // a template that may hold it.
    expect(withLayer({ id: "motion", kind: "animated-text", props: { anchor: "top" } }, "video")).toBe(true);
  });

  test("an image layer carries alt (X2), and the empty string is not absence", () => {
    // The one kind whose whole content is a picture a reader may not see, and
    // therefore the one kind that can *mean* a text alternative. "" declares
    // the image decorative — a claim, not the absence of one — so it parses.
    expect(withLayer({ id: "image", kind: "image", props: { alt: "Two hikers at dawn" } })).toBe(true);
    expect(withLayer({ id: "image", kind: "image", props: { alt: "" } })).toBe(true);
    expect(withLayer({ id: "image", kind: "image", props: {} })).toBe(true);
    expect(layerPropsProblem("image", { alt: "" })).toBeUndefined();
  });

  test("refuses props on a kind that carries none, the empty object included", () => {
    // `html` sits on a type that accepts it, so the props verdict — not X11's
    // `accepts` mirror — is what refuses it there. `fill` is accepted by no
    // creative type (D131), so the whole-template check refuses it for that
    // reason alone; its props rule is asserted directly, or it goes untested.
    expect(withLayer({ id: "html", kind: "html", props: { alt: "x" } }, "image-html")).toBe(false);
    expect(withLayer({ id: "fill", kind: "fill", props: { alpha: 0.5 } })).toBe(false);
    expect(layerPropsProblem("fill", { alpha: 0.5 })).toEqual({
      path: "",
      must: 'be absent for layer kind "fill"',
      value: { alpha: 0.5 },
    });
    // `shade` joined this set by R-D4 (withdrawn 2026-09-15): the tone axis is
    // never absent, so an `alpha` override would always silence it.
    expect(withLayer({ id: "shade", kind: "shade", props: { alpha: 0.5 } })).toBe(false);
    expect(layerPropsProblem("shade", { alpha: 0.5 })).toEqual({
      path: "",
      must: 'be absent for layer kind "shade"',
      value: { alpha: 0.5 },
    });
    // The empty object names no prop, but it is still props on a kind that
    // carries none: the "must be absent" verdict is reached before any
    // entries are walked.
    expect(withLayer({ id: "video", kind: "video", props: {} }, "video")).toBe(false);
    expect(layerPropsProblem("video", {})).toEqual({
      path: "",
      must: 'be absent for layer kind "video"',
      value: {},
    });
    expect(withLayer({ id: "shade", kind: "shade", props: {} })).toBe(false);
    expect(layerPropsProblem("shade", {})).toEqual({
      path: "",
      must: 'be absent for layer kind "shade"',
      value: {},
    });
  });

  test("refuses alt on a kind that cannot mean it — the vocabulary is per kind", () => {
    // X2 adds alt to the image kind alone. An accent is decoration and a text
    // layer's copy is already text, so alt there is a key the kind does not
    // carry, refused exactly as any other unknown key is. (`shade` carries no
    // props at all since R-D4, asserted above.)
    expect(withLayer({ id: "accent", kind: "accent", props: { alt: "x" } })).toBe(false);
    expect(withLayer({ id: "video", kind: "video", props: { alt: "x" } }, "video")).toBe(false);
    expect(layerPropsProblem("accent", { alt: "x" })).toEqual({
      path: ".alt",
      must: 'be one of "solidHeight", "fadeHeight" for layer kind "accent"',
      value: "x",
    });
    // And the image kind's row is `alt` only: giving an image a geometry prop
    // is refused the same way, naming the one key the kind does carry.
    expect(layerPropsProblem("image", { alpha: 0.5 })).toEqual({
      path: ".alpha",
      must: 'be one of "alt" for layer kind "image"',
      value: 0.5,
    });
  });

  test("refuses an alt that is not a string", () => {
    // alt is the one prop that is not a fraction, so it is the one prop the
    // number check must not see.
    expect(layerPropsProblem("image", { alt: 5 })).toEqual({
      path: ".alt",
      must: "be a string",
      value: 5,
    });
    expect(withLayer({ id: "image", kind: "image", props: { alt: null } })).toBe(false);
    expect(withLayer({ id: "image", kind: "image", props: { alt: true } })).toBe(false);
  });

  test("refuses another kind's props (a logo carrying accent's solidHeight)", () => {
    expect(withLayer({ id: "logo", kind: "logo", props: { solidHeight: 0.05 } })).toBe(false);
  });

  test("refuses an unknown key", () => {
    expect(withLayer({ id: "accent", kind: "accent", props: { logoWidth: 0.1 } })).toBe(false);
  });

  test("refuses a number outside [0, 1]", () => {
    expect(withLayer({ id: "accent", kind: "accent", props: { solidHeight: 1.4 } })).toBe(false);
    expect(withLayer({ id: "logo", kind: "logo", props: { width: -0.1 } })).toBe(false);
    expect(withLayer({ id: "text", kind: "static-text", props: { typeFloor: 2 } })).toBe(false);
  });

  test("refuses a prop that is not a finite number", () => {
    expect(withLayer({ id: "accent", kind: "accent", props: { solidHeight: "0.5" } })).toBe(false);
    expect(withLayer({ id: "accent", kind: "accent", props: { solidHeight: Number.NaN } })).toBe(false);
    expect(withLayer({ id: "accent", kind: "accent", props: { solidHeight: Number.POSITIVE_INFINITY } })).toBe(false);
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

describe("templateHasAnchorProp (R-D4)", () => {
  // The domain half of the boundary refusal: whether any text layer carries
  // an `anchor` prop, axis presence left entirely to the caller.
  test("false when no text layer carries an anchor prop", () => {
    expect(templateHasAnchorProp([])).toBe(false);
    expect(templateHasAnchorProp([{ id: "shade", kind: "shade" }])).toBe(false);
    expect(
      templateHasAnchorProp([{ id: "text", kind: "static-text", props: {} }]),
    ).toBe(false);
    expect(
      templateHasAnchorProp([
        { id: "text", kind: "static-text", props: { typeFloor: 0.4 } },
      ]),
    ).toBe(false);
  });

  test("true when a static-text or animated-text layer carries an anchor prop", () => {
    expect(
      templateHasAnchorProp([
        { id: "text", kind: "static-text", props: { anchor: "top" } },
      ]),
    ).toBe(true);
    expect(
      templateHasAnchorProp([
        { id: "motion", kind: "animated-text", props: { anchor: "middle" } },
      ]),
    ).toBe(true);
    // One matching layer among several is enough.
    expect(
      templateHasAnchorProp([
        { id: "image", kind: "image", props: { alt: "x" } },
        { id: "text", kind: "static-text", props: { anchor: "bottom" } },
      ]),
    ).toBe(true);
  });

  test("a non-text layer's own prop named the same is never mistaken for the axis-shadowing one", () => {
    // No other kind's vocabulary carries `anchor` (LAYER_PROPS), so this is a
    // kind-check regression guard, not a live case `layerPropsProblem` would ever admit.
    expect(
      templateHasAnchorProp([
        { id: "logo", kind: "logo", props: { width: 0.1 } },
      ]),
    ).toBe(false);
  });
});

describe("isBriefTemplate layer enabled (D129)", () => {
  // Same shape as the props helper above (X11): the layer under test replaces
  // its canonical counterpart, so `enabled` is the only thing that can refuse.
  const withLayer = (layer: unknown): boolean => {
    const kind = (layer as { kind?: unknown } | null)?.kind;
    const canonical = CANONICAL_TEMPLATES["image-text"].layers;
    return isBriefTemplate({
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers:
        typeof kind === "string" && canonical.some((l) => l.kind === kind)
          ? canonical.map((l) => (l.kind === kind ? layer : l))
          : [...canonical, layer],
    });
  };

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

  test("refuses a text or button element with no copy", () => {
    expect(withElements([{ kind: "text", frame }])).toBe(false);
    expect(withElements([{ kind: "button", frame }])).toBe(false);
  });
});

describe("isBriefTemplate layer tracks (K1)", () => {
  const track = { property: "opacity" as const, stops: [{ t: 0, value: 0, clock: "pose" as const }] };

  /** The canonical image-text template with `tracks` swapped onto its image layer. */
  const withTracks = (tracks: unknown): boolean =>
    isBriefTemplate({
      id: "canonical-image-text",
      version: 1,
      creativeType: "image-text",
      unit: "standard-web",
      layers: [
        { id: "image", kind: "image", tracks },
        { id: "shade", kind: "shade" },
        { id: "accent", kind: "accent" },
        { id: "static-text", kind: "static-text" },
        { id: "logo", kind: "logo" },
      ],
    });

  test("accepts a drawing layer carrying tracks, and absent or empty tracks", () => {
    expect(withTracks(undefined)).toBe(true);
    expect(withTracks([])).toBe(true);
    expect(withTracks([track])).toBe(true);
  });

  test("accepts stops declared t-descending — declaration order is free, only a duplicate t is refused", () => {
    expect(
      withTracks([
        {
          property: "opacity",
          stops: [
            { t: 0.6, value: 0, clock: "pose" },
            { t: 0.2, value: 1, clock: "pose" },
          ],
        },
      ]),
    ).toBe(true);
  });

  test("refuses tracks on shade, logo and accent — no pose mechanism reads eased/motion today (plan review)", () => {
    for (const kind of ["shade", "logo", "accent"] as const) {
      expect(
        isBriefTemplate({
          id: "canonical-image-text",
          version: 1,
          creativeType: "image-text",
          unit: "standard-web",
          layers: [
            { id: "image", kind: "image" },
            { id: "shade", kind: "shade", ...(kind === "shade" ? { tracks: [track] } : {}) },
            { id: "accent", kind: "accent", ...(kind === "accent" ? { tracks: [track] } : {}) },
            { id: "static-text", kind: "static-text" },
            { id: "logo", kind: "logo", ...(kind === "logo" ? { tracks: [track] } : {}) },
          ],
        }),
      ).toBe(false);
    }
  });

  test("refuses tracks on an html layer — the kind's two renderers cannot agree on motion", () => {
    expect(
      isBriefTemplate({
        id: "canonical-image-html",
        version: 1,
        creativeType: "image-html",
        unit: "standard-web",
        layers: [
          { id: "image", kind: "image" },
          { id: "html", kind: "html", tracks: [track] },
          { id: "logo", kind: "logo" },
        ],
      }),
    ).toBe(false);
  });

  test("refuses a malformed track — an unknown property, a bad stop", () => {
    expect(withTracks([{ property: "rotation", stops: track.stops }])).toBe(false);
    expect(withTracks([{ property: "opacity", stops: [{ t: 2, value: 0, clock: "pose" }] }])).toBe(
      false,
    );
  });

  test("refuses a duplicate t on one track's same clock (K-D9)", () => {
    expect(
      withTracks([
        {
          property: "opacity",
          stops: [
            { t: 0.5, value: 0, clock: "pose" },
            { t: 0.5, value: 1, clock: "pose" },
          ],
        },
      ]),
    ).toBe(false);
  });

  test("refuses a track whose stops do not all share one clock (K1b review)", () => {
    expect(
      withTracks([
        {
          property: "opacity",
          stops: [
            { t: 0.5, value: 0, clock: "pose" },
            { t: 0.5, value: 1, clock: "beat" },
          ],
        },
      ]),
    ).toBe(false);
  });

  test("accepts two single-clock tracks on the same property instead — the mixed-clock case above expressed as two tracks", () => {
    expect(
      withTracks([
        { property: "opacity", stops: [{ t: 0.5, value: 0, clock: "pose" }] },
        { property: "opacity", stops: [{ t: 0.5, value: 1, clock: "beat" }] },
      ]),
    ).toBe(true);
  });

  test("refuses every remaining layerTracksProblem rule at this boundary too", () => {
    expect(withTracks([{ property: "opacity", stops: "nope" }])).toBe(false);
    expect(
      withTracks([{ property: "opacity", stops: [{ t: 0, value: NaN, clock: "pose" }] }]),
    ).toBe(false);
    expect(
      withTracks([{ property: "opacity", stops: [{ t: 0, value: 0, clock: "global" }] }]),
    ).toBe(false);
    expect(
      withTracks([
        { property: "opacity", stops: [{ t: 0, value: 0, clock: "pose", easing: "bounce" }] },
      ]),
    ).toBe(false);
    expect(withTracks([{ property: "opacity", stops: track.stops, layer: "image" }])).toBe(false);
    expect(
      withTracks([{ property: "opacity", stops: [{ ...track.stops[0], extra: 1 }] }]),
    ).toBe(false);
  });
});

describe("isBriefTemplate mirrors the API's table rules (X11)", () => {
  /** A well-formed template object for the type, with `layers` swapped in. */
  const asTemplate = (
    creativeType: "image-text" | "image-html" | "video",
    layers: readonly unknown[],
  ) => ({
    id: CANONICAL_TEMPLATES[creativeType].id,
    version: 1,
    creativeType,
    unit: "standard-web",
    layers,
  });

  const imageText = CANONICAL_TEMPLATES["image-text"];
  const video = CANONICAL_TEMPLATES["video"];

  test("refuses a template whose only instance of a required kind is disabled (D129, MP-D4)", () => {
    // The exact case X9's review found: the API refuses it, the editor guard
    // must not. `image` is required for image-text; switch its only instance
    // off and the creative has no picture to draw.
    expect(
      isBriefTemplate(
        asTemplate(
          "image-text",
          imageText.layers.map((l) =>
            l.kind === "image" ? { ...l, enabled: false } : l,
          ),
        ),
      ),
    ).toBe(false);
    // And for video, disabling the only animated-text leaves no required kind.
    expect(
      isBriefTemplate(
        asTemplate(
          "video",
          video.layers.map((l) =>
            l.kind === "animated-text" ? { ...l, enabled: false } : l,
          ),
        ),
      ),
    ).toBe(false);
  });

  test("refuses a template missing a required kind entirely (X11)", () => {
    // The wider half of the gap: never about `enabled` at all — a draft with
    // the required layer deleted has always passed this guard while the API
    // refused it.
    expect(
      isBriefTemplate(
        asTemplate(
          "image-text",
          imageText.layers.filter((l) => l.kind !== "static-text"),
        ),
      ),
    ).toBe(false);
    expect(
      isBriefTemplate(
        asTemplate(
          "video",
          video.layers.filter((l) => l.kind !== "video"),
        ),
      ),
    ).toBe(false);
    expect(
      isBriefTemplate(
        asTemplate(
          "image-html",
          CANONICAL_TEMPLATES["image-html"].layers.filter(
            (l) => l.kind !== "html",
          ),
        ),
      ),
    ).toBe(false);
  });

  test("accepts a required kind with one disabled and one enabled instance", () => {
    // "At least one enabled instance", not "every instance enabled": an extra
    // switched-off image under the live one is legal (and counts against no
    // budget — `image` is unbounded for image-text).
    expect(
      isBriefTemplate(
        asTemplate("image-text", [
          { id: "image-off", kind: "image", enabled: false },
          ...imageText.layers,
        ]),
      ),
    ).toBe(true);
  });

  test("absent enabled counts as enabled (D129)", () => {
    // The canonical library carries no `enabled` key at all; a guard that
    // demanded `enabled === true` would refuse every real template.
    expect(
      isBriefTemplate(
        asTemplate(
          "image-text",
          imageText.layers.map((l) => ({ id: l.id, kind: l.kind })),
        ),
      ),
    ).toBe(true);
    expect(isBriefTemplate(asTemplate("video", video.layers))).toBe(true);
  });

  test("refuses more layers of a kind than the type's per-kind cap (D124)", () => {
    // The API's budget rule, same shape as the required-kind gap: a draft the
    // API refuses must not pass the guard. `image-text` caps `logo` at 1; the
    // appended logo breaks no other rule (order: both images below it).
    expect(
      isBriefTemplate(
        asTemplate("image-text", [
          ...imageText.layers,
          { id: "logo-2", kind: "logo" },
        ]),
      ),
    ).toBe(false);
    // Video caps `shade` at 1 and declares no order constraints, so the cap
    // alone is what refuses this draft.
    expect(
      isBriefTemplate(
        asTemplate("video", [...video.layers, { id: "shade-2", kind: "shade" }]),
      ),
    ).toBe(false);
  });

  test("counts disabled layers against caps and budgets, like the API (MP-D5)", () => {
    // The API's kindCounts is presence-based: a switched-off layer still draws
    // a slot in the compositor's budget. A guard that counted only enabled
    // layers would let a draft with two logos (one off) through where the API
    // refuses it.
    expect(
      isBriefTemplate(
        asTemplate("image-text", [
          ...imageText.layers,
          { id: "logo-2", kind: "logo", enabled: false },
        ]),
      ),
    ).toBe(false);
  });

  test("refuses kinds that share a budget beyond their shared max (D124)", () => {
    // image-text: static-text and animated-text TOGETHER cap at 1 — one of
    // each is an overdraw the API refuses and the compositor cannot draw.
    expect(
      isBriefTemplate(
        asTemplate("image-text", [
          ...imageText.layers.slice(0, 4),
          { id: "motion", kind: "animated-text" },
          imageText.layers[4]!,
        ]),
      ),
    ).toBe(false);
  });

  test("refuses a kind the creative type does not accept (D124)", () => {
    // `video` is a vocabulary member the global layer check admits, but not a
    // kind image-text may hold — the API checks `accepts`, the guard must too.
    expect(
      isBriefTemplate(
        asTemplate("image-text", [
          { id: "vid", kind: "video" },
          ...imageText.layers,
        ]),
      ),
    ).toBe(false);
  });

  test("refuses an empty layers array, like the API's non-empty rule", () => {
    expect(isBriefTemplate(asTemplate("video", []))).toBe(false);
  });

  test("refuses an id that does not match its creative type's canonical template (D124)", () => {
    // The API pairs the two checks (`validateTemplate`'s canonical-match);
    // each field legal on its own is not enough — the id pins the type.
    expect(
      isBriefTemplate({
        id: "canonical-video",
        version: 1,
        creativeType: "image-text",
        unit: "standard-web",
        layers: imageText.layers,
      }),
    ).toBe(false);
  });

  test("refuses a layer with an empty-string id, like the API's non-empty rule", () => {
    expect(
      isBriefTemplate(
        asTemplate(
          "image-text",
          imageText.layers.map((l) =>
            l.kind === "logo" ? { id: "", kind: "logo" } : l,
          ),
        ),
      ),
    ).toBe(false);
  });
});

