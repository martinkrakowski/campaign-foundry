import { describe, test, expect } from "vitest";
import { canonicalTemplate } from "../editor-state";
import {
  CREATIVE_GEOMETRY,
  LAYER_PROP_DEFAULTS,
  layerPropDefault,
} from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import type { BriefTemplate } from "@campaignfoundry/CampaignOrchestration/brief-template";

const template = (layers: unknown[]): BriefTemplate =>
  ({ id: "t", layers }) as unknown as BriefTemplate;

const layerOf = (t: BriefTemplate, i: number) => t.layers[i] as unknown as Record<string, unknown>;

describe("canonicalLayer drops redundant props (SE2)", () => {
  test("an empty props block is the same as no block", () => {
    const out = canonicalTemplate(template([{ kind: "logo", props: {} }]));
    expect(Object.hasOwn(layerOf(out, 0), "props")).toBe(false);
  });

  /**
   * The rule SE2 exists for: a prop written at exactly the default it overrides
   * says nothing absence does not already say, so a brief that spells it out
   * must compare equal to one that omits it — otherwise it dirties on load.
   */
  test("a prop equal to its default is dropped", () => {
    const out = canonicalTemplate(
      template([{ kind: "logo", props: { width: CREATIVE_GEOMETRY.logoWidthFraction } }]),
    );
    expect(Object.hasOwn(layerOf(out, 0), "props")).toBe(false);
  });

  test("a prop that differs from its default is kept, exactly", () => {
    const out = canonicalTemplate(template([{ kind: "logo", props: { width: 0.5 } }]));
    expect(layerOf(out, 0).props).toEqual({ width: 0.5 });
  });

  test("a block loses only its default-valued fields, not the rest", () => {
    const out = canonicalTemplate(
      template([
        {
          kind: "accent",
          props: {
            solidHeight: CREATIVE_GEOMETRY.accentSolidHeightFraction,
            fadeHeight: 0.9,
          },
        },
      ]),
    );
    expect(layerOf(out, 0).props).toEqual({ fadeHeight: 0.9 });
  });

  /**
   * `anchor` and `alpha` shadow a variation axis (C4), so which of the prop or
   * the axis wins is an open owner decision. They have NO default to be equal
   * to, and dropping them would silently resolve that decision.
   */
  test("a prop with no default is never dropped, whatever its value", () => {
    const out = canonicalTemplate(template([{ kind: "static-text", props: { anchor: "top" } }]));
    expect(layerOf(out, 0).props).toEqual({ anchor: "top" });
    expect(layerPropDefault("static-text", "anchor")).toBeUndefined();
  });

  test("an already-canonical layer comes back as the same object", () => {
    const layer = { kind: "logo", props: { width: 0.5 } };
    const out = canonicalTemplate(template([layer]));
    expect(out.layers[0]).toBe(layer);
  });

  test("a layer with no props at all is untouched", () => {
    const layer = { kind: "logo" };
    expect(canonicalTemplate(template([layer])).layers[0]).toBe(layer);
  });
});

describe("the pairing is named once (SE2)", () => {
  /**
   * The compositor reads these same entries — `NodeCanvasCompositor` merges
   * `LAYER_PROP_DEFAULTS.logo.width` over the layer's prop. Restating which
   * constant a prop overrides would be a second geometry, which is what
   * `CREATIVE_GEOMETRY` exists to prevent, so the map is the one statement and
   * this pins it to the constants it is built from.
   */
  test("every entry resolves to its CREATIVE_GEOMETRY constant", () => {
    expect(LAYER_PROP_DEFAULTS.logo.width).toBe(CREATIVE_GEOMETRY.logoWidthFraction);
    expect(LAYER_PROP_DEFAULTS.logo.margin).toBe(CREATIVE_GEOMETRY.logoMarginFraction);
    expect(LAYER_PROP_DEFAULTS.accent.solidHeight).toBe(
      CREATIVE_GEOMETRY.accentSolidHeightFraction,
    );
    expect(LAYER_PROP_DEFAULTS.accent.fadeHeight).toBe(CREATIVE_GEOMETRY.accentFadeHeightFraction);
    expect(LAYER_PROP_DEFAULTS["static-text"].typeFloor).toBe(
      CREATIVE_GEOMETRY.headlineTypeFloorFraction,
    );
    expect(LAYER_PROP_DEFAULTS["animated-text"].typeFloor).toBe(
      CREATIVE_GEOMETRY.headlineTypeFloorFraction,
    );
  });

  test("the axis-shadowing props are absent on purpose", () => {
    expect(layerPropDefault("shade", "alpha")).toBeUndefined();
    expect(layerPropDefault("animated-text", "anchor")).toBeUndefined();
    expect(layerPropDefault("image", "alt")).toBeUndefined();
  });
});
