import { describe, test, expect } from "vitest";
import {
  CANONICAL_TEMPLATES,
  type CreativeTemplateLayer,
} from "@campaignfoundry/CampaignOrchestration/creative-templates";
import type { BriefTemplate } from "@campaignfoundry/CampaignOrchestration/brief-template";
import {
  canonicalTemplate,
  editorReducer,
  initialEditorState,
  type EditorState,
} from "../editor-state";

/**
 * K5 / SE6 / TL5 — the three track actions, `studio-editor.md` §4.4 rules 1–7.
 *
 * The discipline under test is that this reducer states no rule the domain
 * already owns: every refusal below is `layerTracksProblem`'s, reached by
 * dispatching a candidate it rejects and asserting the SAME state object comes
 * back. Delete the `layerTracksProblem` call in `withLayerTracks` and the
 * duplicate-`t`, off-clock and wrong-kind cases all go red — which is the
 * mutation this lane ships.
 */

const CANONICAL = CANONICAL_TEMPLATES["image-text"];

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

const layerOf = (state: EditorState, id: string): CreativeTemplateLayer =>
  state.template.layers.find((candidate) => candidate.id === id)!;

/** The canonical `image-text` layer ids, confirmed rather than assumed. */
const TEXT_ID = CANONICAL.layers.find((l) => l.kind === "static-text")!.id;
const IMAGE_ID = CANONICAL.layers.find((l) => l.kind === "image")!.id;
const SHADE_ID = CANONICAL.layers.find((l) => l.kind === "shade")!.id;

describe("addTrackStop — rules 1, 3, 4", () => {
  test("mints a track on the (property, clock) pair, with the stop it was given", () => {
    const next = editorReducer(stateWith(), {
      type: "addTrackStop",
      layerId: TEXT_ID,
      property: "opacity",
      clock: "pose",
      t: 0.25,
      value: 1,
    });
    expect(layerOf(next, TEXT_ID).tracks).toEqual([
      { property: "opacity", stops: [{ t: 0.25, value: 1, clock: "pose" }] },
    ]);
  });

  test("a second clock on one property is a SECOND track, not a second stop (rule 4)", () => {
    // §4.4 rule 4 has no `setTrackClock` to express it: a track cannot exist
    // before its first stop, so "changing the clock" IS landing the next stop
    // on a different (property, clock) pair. K1b's "two clocks on one property
    // is two separate single-clock tracks".
    const first = editorReducer(stateWith(), {
      type: "addTrackStop",
      layerId: TEXT_ID,
      property: "opacity",
      clock: "pose",
      t: 0,
      value: 1,
    });
    const next = editorReducer(first, {
      type: "addTrackStop",
      layerId: TEXT_ID,
      property: "opacity",
      clock: "beat",
      t: 0,
      value: 0,
    });
    const tracks = layerOf(next, TEXT_ID).tracks!;
    expect(tracks).toHaveLength(2);
    expect(tracks.map((track) => track.stops[0]!.clock)).toEqual(["pose", "beat"]);
  });

  test("a second stop on the same pair joins the track it already has", () => {
    const first = editorReducer(stateWith(), {
      type: "addTrackStop",
      layerId: TEXT_ID,
      property: "opacity",
      clock: "pose",
      t: 0,
      value: 1,
    });
    const next = editorReducer(first, {
      type: "addTrackStop",
      layerId: TEXT_ID,
      property: "opacity",
      clock: "pose",
      t: 1,
      value: 0,
    });
    expect(layerOf(next, TEXT_ID).tracks).toHaveLength(1);
    expect(layerOf(next, TEXT_ID).tracks![0]!.stops).toHaveLength(2);
  });
});

describe("the domain's refusals, called — never restated (rules 5, 6)", () => {
  test("a duplicate `t` on one clock refuses the whole dispatch (rule 6)", () => {
    const first = editorReducer(stateWith(), {
      type: "addTrackStop",
      layerId: TEXT_ID,
      property: "opacity",
      clock: "pose",
      t: 0.5,
      value: 1,
    });
    const next = editorReducer(first, {
      type: "addTrackStop",
      layerId: TEXT_ID,
      property: "opacity",
      clock: "pose",
      t: 0.5,
      value: 0,
    });
    // The SAME object: refused, and therefore no history entry either.
    expect(next).toBe(first);
  });

  test("a `beat` clock on a non-text kind refuses (rule 5)", () => {
    const state = stateWith();
    const next = editorReducer(state, {
      type: "addTrackStop",
      layerId: IMAGE_ID,
      property: "opacity",
      clock: "beat",
      t: 0,
      value: 1,
    });
    expect(next).toBe(state);
  });

  test("a `pose` clock on that same image kind is accepted — the refusal is the clock, not the layer", () => {
    const state = stateWith();
    const next = editorReducer(state, {
      type: "addTrackStop",
      layerId: IMAGE_ID,
      property: "opacity",
      clock: "pose",
      t: 0,
      value: 1,
    });
    expect(next).not.toBe(state);
    expect(layerOf(next, IMAGE_ID).tracks).toHaveLength(1);
  });

  test("a kind outside TRACKABLE_LAYER_KINDS is a no-op", () => {
    const state = stateWith();
    const next = editorReducer(state, {
      type: "addTrackStop",
      layerId: SHADE_ID,
      property: "opacity",
      clock: "pose",
      t: 0,
      value: 1,
    });
    expect(next).toBe(state);
  });

  test("an unknown layer id is a no-op", () => {
    const state = stateWith();
    expect(
      editorReducer(state, {
        type: "addTrackStop",
        layerId: "no-such-layer",
        property: "opacity",
        clock: "pose",
        t: 0,
        value: 1,
      }),
    ).toBe(state);
  });
});

describe("setTrackStop", () => {
  const seeded = () =>
    editorReducer(stateWith(), {
      type: "addTrackStop",
      layerId: TEXT_ID,
      property: "opacity",
      clock: "pose",
      t: 0,
      value: 1,
    });

  test("edits one stop's value", () => {
    const next = editorReducer(seeded(), {
      type: "setTrackStop",
      layerId: TEXT_ID,
      trackIndex: 0,
      stopIndex: 0,
      patch: { value: 0.5 },
    });
    expect(layerOf(next, TEXT_ID).tracks![0]!.stops[0]!.value).toBe(0.5);
  });

  test("an easing of `undefined` CLEARS the key rather than writing a default's name", () => {
    const withEasing = editorReducer(seeded(), {
      type: "setTrackStop",
      layerId: TEXT_ID,
      trackIndex: 0,
      stopIndex: 0,
      patch: { easing: "linear" },
    });
    expect(
      withEasing.template.layers.find((l) => l.id === TEXT_ID)!.tracks![0]!.stops[0]!.easing,
    ).toBe("linear");
    const cleared = editorReducer(withEasing, {
      type: "setTrackStop",
      layerId: TEXT_ID,
      trackIndex: 0,
      stopIndex: 0,
      patch: { easing: undefined },
    });
    // Absent, not `easing: undefined` and not the default's own name — absence
    // IS the domain default (K-D7).
    expect(
      "easing" in cleared.template.layers.find((l) => l.id === TEXT_ID)!.tracks![0]!.stops[0]!,
    ).toBe(false);
  });

  test("an edit that changes nothing returns the SAME state — no history entry", () => {
    const state = seeded();
    expect(
      editorReducer(state, {
        type: "setTrackStop",
        layerId: TEXT_ID,
        trackIndex: 0,
        stopIndex: 0,
        patch: { value: 1 },
      }),
    ).toBe(state);
  });

  test("moving a stop onto another stop's `t` is refused by the domain", () => {
    const two = editorReducer(seeded(), {
      type: "addTrackStop",
      layerId: TEXT_ID,
      property: "opacity",
      clock: "pose",
      t: 1,
      value: 0,
    });
    expect(
      editorReducer(two, {
        type: "setTrackStop",
        layerId: TEXT_ID,
        trackIndex: 0,
        stopIndex: 1,
        patch: { t: 0 },
      }),
    ).toBe(two);
  });

  test("an out-of-range index is a no-op", () => {
    const state = seeded();
    expect(
      editorReducer(state, {
        type: "setTrackStop",
        layerId: TEXT_ID,
        trackIndex: 9,
        stopIndex: 0,
        patch: { value: 0 },
      }),
    ).toBe(state);
    expect(
      editorReducer(state, {
        type: "setTrackStop",
        layerId: TEXT_ID,
        trackIndex: 0,
        stopIndex: 9,
        patch: { value: 0 },
      }),
    ).toBe(state);
  });
});

describe("removeTrackStop — rule 7, and the canonical form", () => {
  const seeded = () =>
    editorReducer(stateWith(), {
      type: "addTrackStop",
      layerId: TEXT_ID,
      property: "opacity",
      clock: "pose",
      t: 0,
      value: 1,
    });

  test("removing the LAST stop drops the whole track, never `stops: []`", () => {
    // The domain refuses an empty `stops` array outright ("be a non-empty
    // array of stops"), so leaving one behind would make this edit impossible
    // rather than merely untidy.
    const next = editorReducer(seeded(), {
      type: "removeTrackStop",
      layerId: TEXT_ID,
      trackIndex: 0,
      stopIndex: 0,
    });
    expect(layerOf(next, TEXT_ID).tracks).toBeUndefined();
  });

  test("an add then a remove returns the layer to the object it started as", () => {
    // The round-trip property `withElements` exists for: the template is not
    // merely equal, the `tracks` key is gone, so a draft does not read dirty
    // for a change the user undid.
    const start = stateWith();
    const next = editorReducer(seeded(), {
      type: "removeTrackStop",
      layerId: TEXT_ID,
      trackIndex: 0,
      stopIndex: 0,
    });
    expect(layerOf(next, TEXT_ID)).toEqual(layerOf(start, TEXT_ID));
  });

  test("removing one of two leaves the track with the other", () => {
    const two = editorReducer(seeded(), {
      type: "addTrackStop",
      layerId: TEXT_ID,
      property: "opacity",
      clock: "pose",
      t: 1,
      value: 0,
    });
    const next = editorReducer(two, {
      type: "removeTrackStop",
      layerId: TEXT_ID,
      trackIndex: 0,
      stopIndex: 0,
    });
    expect(layerOf(next, TEXT_ID).tracks![0]!.stops).toEqual([{ t: 1, value: 0, clock: "pose" }]);
  });

  test("an out-of-range index is a no-op", () => {
    const state = seeded();
    expect(
      editorReducer(state, {
        type: "removeTrackStop",
        layerId: TEXT_ID,
        trackIndex: 0,
        stopIndex: 5,
      }),
    ).toBe(state);
  });
});

describe("canonicalLayer learns `tracks`", () => {
  // Tested through `canonicalTemplate` rather than through a dispatch, and the
  // first draft of this file got that wrong. The reducer runs `canonicalLayer`
  // on the ONE layer its action names (`i === edit.layerIndex`, the
  // `setLayerProps` rule), so editing layer A can never canonicalise layer B.
  // The path that actually carries an empty list is a brief arriving from disk,
  // which `canonicalTemplate` walks whole.
  test("a layer arriving with `tracks: []` has the key dropped", () => {
    // `layerTracksProblem` ACCEPTS `tracks: []` — it walks no entries — so
    // nothing else in the pipeline would remove it, and a brief that spelled
    // the empty list out would read as different from the same template saved
    // without it.
    const withEmpty = CANONICAL.layers.map((l) =>
      l.id === TEXT_ID ? ({ ...l, tracks: [] } as CreativeTemplateLayer) : l,
    );
    const out = canonicalTemplate(template(withEmpty));
    expect("tracks" in out.layers.find((l) => l.id === TEXT_ID)!).toBe(false);
  });

  test("a layer carrying real tracks keeps them, and the template comes back identical", () => {
    // The reference-equality half of `canonicalLayer`'s contract: a template
    // already canonical must come back untouched, or every layer carrying
    // tracks would mark the draft dirty on every call.
    const withTracks = CANONICAL.layers.map((l) =>
      l.id === TEXT_ID
        ? ({
            ...l,
            tracks: [{ property: "opacity", stops: [{ t: 0, value: 1, clock: "pose" }] }],
          } as CreativeTemplateLayer)
        : l,
    );
    const input = template(withTracks);
    expect(canonicalTemplate(input)).toBe(input);
  });
});

describe("a layer with two tracks — the arm that leaves the other one alone", () => {
  /**
   * Each action maps over the whole list, so every one has a branch for "this
   * is not the track you named". With a single track that arm never runs, and
   * the first version of this file never reached it: a bug that touched the
   * wrong track would have been invisible.
   */
  const twoTracks = () => {
    const first = editorReducer(stateWith(), {
      type: "addTrackStop",
      layerId: TEXT_ID,
      property: "opacity",
      clock: "pose",
      t: 0,
      value: 1,
    });
    return editorReducer(first, {
      type: "addTrackStop",
      layerId: TEXT_ID,
      property: "scale",
      clock: "pose",
      t: 0,
      value: 1,
    });
  };

  test("adding to the second track leaves the first untouched", () => {
    const state = twoTracks();
    const next = editorReducer(state, {
      type: "addTrackStop",
      layerId: TEXT_ID,
      property: "scale",
      clock: "pose",
      t: 1,
      value: 2,
    });
    const tracks = layerOf(next, TEXT_ID).tracks!;
    expect(tracks[0]).toBe(layerOf(state, TEXT_ID).tracks![0]);
    expect(tracks[1]!.stops).toHaveLength(2);
  });

  test("editing a stop on the second track leaves the first untouched", () => {
    const state = twoTracks();
    const next = editorReducer(state, {
      type: "setTrackStop",
      layerId: TEXT_ID,
      trackIndex: 1,
      stopIndex: 0,
      patch: { value: 0.25 },
    });
    const tracks = layerOf(next, TEXT_ID).tracks!;
    expect(tracks[0]).toEqual(layerOf(state, TEXT_ID).tracks![0]);
    expect(tracks[1]!.stops[0]!.value).toBe(0.25);
  });

  test("removing the second track's only stop drops just that track", () => {
    const next = editorReducer(twoTracks(), {
      type: "removeTrackStop",
      layerId: TEXT_ID,
      trackIndex: 1,
      stopIndex: 0,
    });
    const tracks = layerOf(next, TEXT_ID).tracks!;
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.property).toBe("opacity");
  });
});
