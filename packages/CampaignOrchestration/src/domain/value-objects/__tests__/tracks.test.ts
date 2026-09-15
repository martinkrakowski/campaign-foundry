import { describe, test, expect } from "vitest";
import type { LayerKind } from "../layer-kinds.js";
import { STOP_CLOCKS, TRACK_PROPERTIES, layerTracksProblem } from "../tracks.js";

/** A minimal, valid single-stop track on `opacity`. */
const opacityTrack = {
  property: "opacity" as const,
  stops: [{ t: 0, value: 0, clock: "pose" as const }, { t: 1, value: 1, clock: "pose" as const }],
};

describe("track and stop vocabularies (§1, K-D8)", () => {
  test("TRACK_PROPERTIES names exactly what the compositor moves today", () => {
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

  test("every kind this compositor draws through its own drawer accepts a well-formed track, empty list included", () => {
    const drawingKinds: LayerKind[] = [
      "image",
      "video",
      "shade",
      "accent",
      "static-text",
      "animated-text",
      "logo",
    ];
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

describe("layerTracksProblem — ordering (K-D9's only refusal)", () => {
  test("accepts stops strictly increasing in t within one clock", () => {
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

  test("refuses stops out of order (descending) within one clock", () => {
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
    ).toEqual({
      path: "[0].stops[1].t",
      must: 'be strictly greater than the previous "pose"-clock stop\'s t (0.5)',
      value: 0.2,
    });
  });

  test("refuses a duplicate t within one clock on one track (K-D9)", () => {
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
      must: 'be strictly greater than the previous "pose"-clock stop\'s t (0.5)',
      value: 0.5,
    });
  });

  test("the same numeric t on two DIFFERENT clocks in one track is legal — they are independent axes", () => {
    expect(
      layerTracksProblem("image", [
        {
          property: "opacity",
          stops: [
            { t: 0.5, value: 0, clock: "pose" },
            { t: 0.5, value: 1, clock: "beat" },
          ],
        },
      ]),
    ).toBeUndefined();
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
