import { describe, test, expect } from "vitest";
import {
  CANONICAL_TEMPLATES,
  type CreativeTemplateLayer,
} from "@campaignfoundry/CampaignOrchestration/creative-templates";
import type { BriefTemplate } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { editorReducer, initialEditorState, toBrief, type EditorState } from "../editor-state";

/**
 * CC4, D134 — `setLayerProps`: live geometry overrides on a layer, mirroring
 * `setLayerEnabled`'s shape (locate by id, no-op the same state object when
 * nothing changed) and `setHtmlElementStyle`'s canonical-form discipline (a
 * field set to `undefined` clears it, and the whole block drops once none are
 * left).
 *
 * The property that matters most is the last one: a layer this action never
 * mentions field-for-field (`enabled`) still comes out through
 * `canonicalLayer` — proven here by feeding the reducer a layer that arrived
 * non-canonical (bypassing `fromBrief`/`normalizeDraftState`, which already
 * canonicalise everything that goes through them), so the property is only
 * visible when the fixture itself does not already hide it.
 */

const CANONICAL = CANONICAL_TEMPLATES["image-text"];

/** The canonical `image-text` template: image, shade, accent, static-text, logo. */
const template = (layers: readonly CreativeTemplateLayer[] = CANONICAL.layers): BriefTemplate => ({
  id: "canonical-image-text",
  version: CANONICAL.version,
  creativeType: CANONICAL.creativeType,
  unit: CANONICAL.unit,
  layers,
});

const stateWith = (layers: readonly CreativeTemplateLayer[] = CANONICAL.layers): EditorState => ({
  ...initialEditorState(),
  template: template(layers),
});

const layer = (state: EditorState, id: string): CreativeTemplateLayer =>
  state.template.layers.find((candidate) => candidate.id === id)!;

describe("setLayerProps — locating the layer (the setLayerEnabled shape)", () => {
  test("a layer id that names no row is a no-op — the same state object", () => {
    const before = stateWith();
    const next = editorReducer(before, {
      type: "setLayerProps",
      layerId: "nope",
      patch: { solidHeight: 0.2 },
    });
    expect(next).toBe(before);
  });

  test("a value already stored is a no-op — no history entry to create", () => {
    const set = editorReducer(stateWith(), {
      type: "setLayerProps",
      layerId: "accent",
      patch: { solidHeight: 0.2 },
    });
    const again = editorReducer(set, {
      type: "setLayerProps",
      layerId: "accent",
      patch: { solidHeight: 0.2 },
    });
    expect(again).toBe(set);
  });
});

describe("setLayerProps — the domain's own field table refuses the rest (D134)", () => {
  test("a field the kind does not carry refuses the whole dispatch", () => {
    const before = stateWith();
    // `width` is `logo`'s field, not `accent`'s — a patch may name any kind's
    // field at the type level (`LayerPropsPatch`), and `layerPropsProblem` is
    // the boundary that refuses it against the DISPATCHED layer's own kind.
    const next = editorReducer(before, {
      type: "setLayerProps",
      layerId: "accent",
      patch: { width: 0.1 },
    });
    expect(next).toBe(before);
  });

  test("an anchor value outside the vocabulary refuses the whole dispatch", () => {
    const before = stateWith();
    const next = editorReducer(before, {
      type: "setLayerProps",
      layerId: "static-text",
      // @ts-expect-error — same boundary as above.
      patch: { anchor: "diagonal" },
    });
    expect(next).toBe(before);
  });

  test("a kind that carries no props at all (html) refuses every patch, empty included", () => {
    const html: CreativeTemplateLayer = { id: "html", kind: "html" };
    const before = stateWith([...CANONICAL.layers, html]);
    const next = editorReducer(before, {
      type: "setLayerProps",
      layerId: "html",
      patch: { solidHeight: 0.2 },
    });
    expect(next).toBe(before);
  });
});

describe("setLayerProps — numeric fields clamp into [0, 1] (the clampedFrame rule)", () => {
  test("a value above 1 is clamped to 1", () => {
    const next = editorReducer(stateWith(), {
      type: "setLayerProps",
      layerId: "logo",
      patch: { width: 1.5 },
    });
    expect((layer(next, "logo").props as { width?: number } | undefined)?.width).toBe(1);
  });

  test("a value below 0 is clamped to 0", () => {
    const next = editorReducer(stateWith(), {
      type: "setLayerProps",
      layerId: "logo",
      patch: { margin: -0.4 },
    });
    expect((layer(next, "logo").props as { margin?: number } | undefined)?.margin).toBe(0);
  });

  test("a non-finite value changes nothing for that field", () => {
    const before = stateWith();
    const next = editorReducer(before, {
      type: "setLayerProps",
      layerId: "accent",
      patch: { solidHeight: Number.NaN },
    });
    expect(next).toBe(before);
  });
});

describe("setLayerProps — set then clear is byte-identical (X16, D134)", () => {
  test("a single prop: the layer, and the whole serialised brief, return exactly as loaded", () => {
    const before = stateWith();
    const set = editorReducer(before, {
      type: "setLayerProps",
      layerId: "accent",
      patch: { solidHeight: 0.2 },
    });
    expect(layer(set, "accent").props).toEqual({ solidHeight: 0.2 });
    const cleared = editorReducer(set, {
      type: "setLayerProps",
      layerId: "accent",
      patch: { solidHeight: undefined },
    });
    expect("props" in layer(cleared, "accent")).toBe(false);
    // Not merely equivalent — deep-equal against the ORIGINAL serialised brief.
    expect(toBrief(cleared)).toEqual(toBrief(before));
  });

  test("two props on the same layer: clearing both drops the whole block, not an empty one", () => {
    const set = editorReducer(
      editorReducer(stateWith(), {
        type: "setLayerProps",
        layerId: "logo",
        patch: { width: 0.2 },
      }),
      { type: "setLayerProps", layerId: "logo", patch: { margin: 0.1 } },
    );
    expect(layer(set, "logo").props).toEqual({ width: 0.2, margin: 0.1 });
    const cleared = editorReducer(
      editorReducer(set, {
        type: "setLayerProps",
        layerId: "logo",
        patch: { width: undefined },
      }),
      { type: "setLayerProps", layerId: "logo", patch: { margin: undefined } },
    );
    expect("props" in layer(cleared, "logo")).toBe(false);
  });

  test("image's alt: absent, decorative (empty string) and text are three different states", () => {
    const before = stateWith();
    const decorative = editorReducer(before, {
      type: "setLayerProps",
      layerId: "image",
      patch: { alt: "" },
    });
    // The empty string is a real, intentional value — not absence.
    expect(layer(decorative, "image").props).toEqual({ alt: "" });
    const cleared = editorReducer(decorative, {
      type: "setLayerProps",
      layerId: "image",
      patch: { alt: undefined },
    });
    expect("props" in layer(cleared, "image")).toBe(false);
    expect(toBrief(cleared)).toEqual(toBrief(before));
  });
});

describe("setLayerProps — canonicalLayer's own duty, not restated here (D129, D134)", () => {
  test("a layer that arrived non-canonical is canonicalised by this action too, on a field it never touched", () => {
    // Bypasses `fromBrief` / `normalizeDraftState` on purpose: both already
    // canonicalise on the way in, which would hide this property behind a
    // fixture that was never non-canonical to begin with.
    const nonCanonical = stateWith(
      CANONICAL.layers.map((candidate) =>
        candidate.id === "accent" ? { ...candidate, enabled: true } : candidate,
      ),
    );
    expect(layer(nonCanonical, "accent").enabled).toBe(true);
    const next = editorReducer(nonCanonical, {
      type: "setLayerProps",
      layerId: "accent",
      patch: { solidHeight: 0.2 },
    });
    expect(layer(next, "accent").props).toEqual({ solidHeight: 0.2 });
    // `setLayerProps` never writes `enabled` — `canonicalLayer` is what drops it.
    expect("enabled" in layer(next, "accent")).toBe(false);
  });
});
