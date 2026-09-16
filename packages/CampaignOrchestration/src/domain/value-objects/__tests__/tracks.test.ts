import { describe, test, expect } from "vitest";
import type { LayerKind } from "../layer-kinds.js";
import { STOP_CLOCKS, TRACK_PROPERTIES, layerTracksProblem } from "../tracks.js";

/** A minimal, valid single-stop track on `opacity`. */
const opacityTrack = {
  property: "opacity" as const,
  stops: [{ t: 0, value: 0, clock: "pose" as const }, { t: 1, value: 1, clock: "pose" as const }],
};

describe("track and stop vocabularies (keyframing plan §1 \"The model\", K-D8)", () => {
  test("TRACK_PROPERTIES names the four initial pose properties, not every motion the compositor draws", () => {
    expect(TRACK_PROPERTIES).toEqual(["opacity", "scale", "dx", "dy"]);
  });

  test("STOP_CLOCKS names the three clocks (K-D8)", () => {
    expect(STOP_CLOCKS).toEqual(["pose", "beat", "effect"]);
  });
});

describe("layerTracksProblem — which kinds accept tracks", () => {
  test("absent tracks are always fine, on every kind", () => {
    const kinds: LayerKind[] = [
      "image",
      "video",
      "shade",
      "accent",
      "static-text",
      "animated-text",
      "logo",
      "html",
      "fill",
    ];
    for (const kind of kinds) {
      expect(layerTracksProblem(kind, undefined)).toBeUndefined();
    }
  });

  test("the kinds K2/K3 drive accept a well-formed track, empty list included", () => {
    const drawingKinds: LayerKind[] = ["image", "video", "static-text", "animated-text"];
    for (const kind of drawingKinds) {
      expect(layerTracksProblem(kind, [])).toBeUndefined();
      expect(layerTracksProblem(kind, [opacityTrack])).toBeUndefined();
    }
  });

  test("refuses tracks on html — it renders through two paths and only one has a motion mechanism", () => {
    expect(layerTracksProblem("html", [])).toEqual({
      path: "",
      must: 'be absent for layer kind "html"',
      value: [],
    });
    expect(layerTracksProblem("html", [opacityTrack])).toEqual({
      path: "",
      must: 'be absent for layer kind "html"',
      value: [opacityTrack],
    });
  });

  test("refuses tracks on fill — no creative type accepts the kind yet (D131), so nothing would read it", () => {
    expect(layerTracksProblem("fill", [])).toEqual({
      path: "",
      must: 'be absent for layer kind "fill"',
      value: [],
    });
  });

  test("refuses tracks on shade, logo and accent — no pose mechanism reads eased/motion today (plan review)", () => {
    for (const kind of ["shade", "logo", "accent"] as const) {
      expect(layerTracksProblem(kind, [opacityTrack])).toEqual({
        path: "",
        must: `be absent for layer kind "${kind}"`,
        value: [opacityTrack],
      });
    }
  });
});

describe("layerTracksProblem — beat/effect clocks need a text-kind layer (K1b review fix round 2)", () => {
  // A beat/effect-clock stop needs a *beat* to be beat-local against, and
  // only a text layer's pose is resolved per beat (resolveTracks's `copy`,
  // K-D6) -- image/video resolve into `byLayer`, one pose per layer with no
  // per-beat multiplicity, so during a crossfade there is no defined answer
  // for which of the (at most two) live beats' local progress such a track
  // would read. Refused here instead of resolved to an arbitrary one.

  test("refuses a beat-clock stop on image", () => {
    expect(
      layerTracksProblem("image", [
        { property: "opacity", stops: [{ t: 0, value: 0, clock: "beat" }] },
      ]),
    ).toEqual({
      path: "[0].stops[0].clock",
      must: 'be "pose" for layer kind "image" (a beat- or effect-clock track needs a beat, which only a text layer has)',
      value: "beat",
    });
  });

  test("refuses an effect-clock stop on video", () => {
    expect(
      layerTracksProblem("video", [
        { property: "opacity", stops: [{ t: 0, value: 0, clock: "effect" }] },
      ]),
    ).toEqual({
      path: "[0].stops[0].clock",
      must: 'be "pose" for layer kind "video" (a beat- or effect-clock track needs a beat, which only a text layer has)',
      value: "effect",
    });
  });

  test("accepts a beat-clock stop on static-text and an effect-clock stop on animated-text", () => {
    expect(
      layerTracksProblem("static-text", [
        { property: "dy", stops: [{ t: 0, value: 0, clock: "beat" }] },
      ]),
    ).toBeUndefined();
    expect(
      layerTracksProblem("animated-text", [
        { property: "opacity", stops: [{ t: 0, value: 0, clock: "effect" }] },
      ]),
    ).toBeUndefined();
  });

  test("a pose-clock stop is fine on every trackable kind, image and video included", () => {
    for (const kind of ["image", "video", "static-text", "animated-text"] as const) {
      expect(layerTracksProblem(kind, [opacityTrack])).toBeUndefined();
    }
  });
});

describe("layerTracksProblem — structural refusals", () => {
  test("refuses tracks that are not an array", () => {
    for (const value of ["nope", 5, {}, null]) {
      expect(layerTracksProblem("image", value)).toEqual({
        path: "",
        must: "be an array of tracks",
        value,
      });
    }
  });

  test("refuses a list entry that is not a track object", () => {
    for (const entry of ["nope", 5, null, []]) {
      expect(layerTracksProblem("image", [entry])).toEqual({
        path: "[0]",
        must: "be an object",
        value: entry,
      });
    }
  });

  test("refuses an unknown or missing property", () => {
    for (const property of ["rotation", "blendMode", undefined, 5]) {
      expect(
        layerTracksProblem("image", [{ property, stops: opacityTrack.stops }]),
      ).toEqual({
        path: "[0].property",
        must: 'be one of "opacity", "scale", "dx", "dy"',
        value: property,
      });
    }
  });

  test("refuses a field the track shape does not carry — a `layer` field is the second addressing scheme K-D4 refuses", () => {
    expect(
      layerTracksProblem("image", [{ ...opacityTrack, layer: "image" }]),
    ).toEqual({
      path: "[0].layer",
      must: 'be one of "property", "stops"',
      value: "image",
    });
  });

  test("refuses stops that are not a non-empty array", () => {
    for (const stops of ["nope", 5, null, []]) {
      expect(layerTracksProblem("image", [{ property: "opacity", stops }])).toEqual({
        path: "[0].stops",
        must: "be a non-empty array of stops",
        value: stops,
      });
    }
  });

  test("refuses a stop entry that is not an object", () => {
    for (const entry of ["nope", 5, null, []]) {
      expect(
        layerTracksProblem("image", [{ property: "opacity", stops: [entry] }]),
      ).toEqual({
        path: "[0].stops[0]",
        must: "be an object",
        value: entry,
      });
    }
  });

  test("refuses a field a stop does not carry", () => {
    expect(
      layerTracksProblem("image", [
        { property: "opacity", stops: [{ t: 0, value: 0, clock: "pose", extra: 1 }] },
      ]),
    ).toEqual({
      path: "[0].stops[0].extra",
      must: 'be one of "t", "value", "easing", "clock"',
      value: 1,
    });
  });

  test("refuses a t outside [0, 1], missing, or non-finite", () => {
    for (const t of [-0.1, 1.1, Infinity, NaN, "0.5", undefined]) {
      expect(
        layerTracksProblem("image", [
          { property: "opacity", stops: [{ t, value: 0, clock: "pose" }] },
        ]),
      ).toEqual({
        path: "[0].stops[0].t",
        must: "be a number in [0, 1]",
        value: t,
      });
    }
  });

  test("refuses a non-finite or missing value", () => {
    for (const value of [Infinity, -Infinity, NaN, "1", undefined]) {
      expect(
        layerTracksProblem("image", [
          { property: "opacity", stops: [{ t: 0, value, clock: "pose" }] },
        ]),
      ).toEqual({
        path: "[0].stops[0].value",
        must: "be a finite number",
        value,
      });
    }
  });

  test("refuses an unknown or missing clock", () => {
    for (const clock of ["global", undefined, 5]) {
      expect(
        layerTracksProblem("image", [
          { property: "opacity", stops: [{ t: 0, value: 0, clock }] },
        ]),
      ).toEqual({
        path: "[0].stops[0].clock",
        must: 'be one of "pose", "beat", "effect"',
        value: clock,
      });
    }
  });

  test("refuses an unknown easing override; accepts the vocabulary's own two members, and absent", () => {
    expect(
      layerTracksProblem("image", [
        { property: "opacity", stops: [{ t: 0, value: 0, clock: "pose", easing: "bounce" }] },
      ]),
    ).toEqual({
      path: "[0].stops[0].easing",
      must: 'be one of "ease-out-cubic", "linear"',
      value: "bounce",
    });
    for (const easing of ["ease-out-cubic", "linear", undefined]) {
      expect(
        layerTracksProblem("image", [
          { property: "opacity", stops: [{ t: 0, value: 0, clock: "pose", easing }] },
        ]),
      ).toBeUndefined();
    }
  });

  test("names the offending track and stop by index", () => {
    expect(
      layerTracksProblem("image", [
        opacityTrack,
        { property: "scale", stops: [{ t: 0, value: 1, clock: "pose" }, { t: 2, value: 1, clock: "pose" }] },
      ]),
    ).toEqual({
      path: "[1].stops[1].t",
      must: "be a number in [0, 1]",
      value: 2,
    });
  });
});

describe("layerTracksProblem — one clock per track (K1b review), and duplicate t within it (K-D9)", () => {
  test("accepts stops declared t-ascending within one clock", () => {
    expect(
      layerTracksProblem("image", [
        {
          property: "dx",
          stops: [
            { t: 0, value: 0, clock: "pose" },
            { t: 0.5, value: 5, clock: "pose" },
            { t: 1, value: 10, clock: "pose" },
          ],
        },
      ]),
    ).toBeUndefined();
  });

  test("accepts stops declared t-descending — declaration order is free, only a duplicate t is refused", () => {
    expect(
      layerTracksProblem("image", [
        {
          property: "dx",
          stops: [
            { t: 0.5, value: 5, clock: "pose" },
            { t: 0.2, value: 0, clock: "pose" },
          ],
        },
      ]),
    ).toBeUndefined();
  });

  test("refuses a duplicate t within one clock on one track (K-D9), wherever in the list it repeats", () => {
    expect(
      layerTracksProblem("image", [
        {
          property: "opacity",
          stops: [
            { t: 0.5, value: 0, clock: "pose" },
            { t: 0.5, value: 1, clock: "pose" },
          ],
        },
      ]),
    ).toEqual({
      path: "[0].stops[1].t",
      must: 'be unique among this track\'s "pose"-clock stops (duplicate 0.5)',
      value: 0.5,
    });
    // Not merely adjacent duplicates — a third, later stop repeating an
    // earlier clock's t is refused too, out of declaration order.
    expect(
      layerTracksProblem("image", [
        {
          property: "opacity",
          stops: [
            { t: 0.5, value: 0, clock: "pose" },
            { t: 0.2, value: 1, clock: "pose" },
            { t: 0.5, value: 2, clock: "pose" },
          ],
        },
      ]),
    ).toEqual({
      path: "[0].stops[2].t",
      must: 'be unique among this track\'s "pose"-clock stops (duplicate 0.5)',
      value: 0.5,
    });
  });

  // beat/effect clocks need a text-kind layer (K1b review fix round 2:
  // layerTracksProblem now also refuses beat/effect on a non-text kind), so
  // every fixture below that mixes clocks other than pose uses
  // "static-text" rather than the suite's usual "image".

  test("the same numeric t on two different clocks needs two tracks — one track's stops share one clock (K1b review)", () => {
    // What the retired test below called "independent axes in one track" is
    // now expressed as two separate, single-clock tracks composing on the
    // same property per K-D9 — never refused.
    expect(
      layerTracksProblem("static-text", [
        { property: "opacity", stops: [{ t: 0.5, value: 0, clock: "pose" }] },
        { property: "opacity", stops: [{ t: 0.5, value: 1, clock: "beat" }] },
      ]),
    ).toBeUndefined();
  });

  test("refuses a track whose stops do not all share one clock (K1b review)", () => {
    // Previously legal (the "independent axes" framing above); closed
    // because the resolver silently ignored the off-clock stop instead of
    // ever reading it — data loss with no message. Distinct `t` values
    // (0.5 / 0.75) so this fails for the clock mismatch alone: with the same
    // `t` on both stops, disabling the clock check alone still leaves a
    // refusal (the duplicate-`t` rule fires instead), which would pass this
    // very assertion for the wrong reason if it used `toBe(false)` rather
    // than the exact object below.
    expect(
      layerTracksProblem("static-text", [
        {
          property: "opacity",
          stops: [
            { t: 0.5, value: 0, clock: "pose" },
            { t: 0.75, value: 1, clock: "beat" },
          ],
        },
      ]),
    ).toEqual({
      path: "[0].stops[1].clock",
      must: 'be "pose", the clock this track\'s first stop names (a track\'s stops share one clock)',
      value: "beat",
    });
  });

  test("refuses a mixed-clock track even when the differing stop comes first in a longer list", () => {
    expect(
      layerTracksProblem("static-text", [
        {
          property: "opacity",
          stops: [
            { t: 0, value: 0, clock: "effect" },
            { t: 0.5, value: 1, clock: "pose" },
            { t: 1, value: 2, clock: "pose" },
          ],
        },
      ]),
    ).toEqual({
      path: "[0].stops[1].clock",
      must: 'be "effect", the clock this track\'s first stop names (a track\'s stops share one clock)',
      value: "pose",
    });
  });

  test("two tracks composing on one property is legal — never refused (K-D9)", () => {
    expect(
      layerTracksProblem("image", [
        { property: "dx", stops: [{ t: 0, value: 1, clock: "pose" }] },
        { property: "dx", stops: [{ t: 0, value: 2, clock: "pose" }] },
      ]),
    ).toBeUndefined();
  });

  test("a valid multi-track, multi-clock layer is accepted", () => {
    expect(
      layerTracksProblem("static-text", [
        {
          property: "dy",
          stops: [
            { t: 0, value: 0.12, clock: "beat" },
            { t: 1, value: 0, clock: "beat", easing: "linear" },
          ],
        },
        {
          property: "opacity",
          stops: [
            { t: 0, value: 0, clock: "effect" },
            { t: 1, value: 1, clock: "effect" },
          ],
        },
      ]),
    ).toBeUndefined();
  });
});
