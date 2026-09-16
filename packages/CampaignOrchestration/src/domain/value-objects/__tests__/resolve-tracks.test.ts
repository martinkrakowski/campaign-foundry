import { describe, test, expect } from "vitest";
import { beatAt, resolveTimeline, type CopyTimeline } from "../CopyTimeline.vo.js";
import { easeOutCubic } from "../easing.js";
import { IDENTITY_POSE, IMPLICIT_BEAT, poseOf, resolveTracks, type TrackedLayer } from "../resolve-tracks.js";
import type { Track } from "../tracks.js";

/** A single-stop track holds its one value everywhere — a cheap constant fixture. */
function constant(property: Track["property"], value: number): Track {
  return { property, stops: [{ t: 0, value, clock: "pose" }] };
}

describe("resolveTracks — interpolation per clock (K-D8)", () => {
  test("pose clock at t = 0, 0.5, 1 with the default easing, a linear override on the STARTING stop, and the ending stop's easing not leaking into the segment before it", () => {
    const track: Track = {
      property: "dx",
      stops: [
        { t: 0, value: 0, clock: "pose" },
        { t: 0.5, value: 10, clock: "pose", easing: "linear" },
        { t: 1, value: 0, clock: "pose" },
      ],
    };
    const layers: TrackedLayer[] = [{ id: "img", kind: "image", tracks: [track] }];

    // First segment [0, 0.5]: starts at the t=0 stop, which names no easing
    // override, so it defaults to ease-out-cubic -- even though the t=0.5
    // stop (this segment's ENDING stop) declares "linear".
    const atQuarter = resolveTracks(layers, [], { t: 0.25 });
    expect(atQuarter.byLayer.get("img")!.dx).toBe(0 + (10 - 0) * easeOutCubic(0.5));

    // Second segment [0.5, 1]: starts at the t=0.5 stop, whose own "linear"
    // override now applies, as the STARTING stop of this segment.
    const atThreeQuarters = resolveTracks(layers, [], { t: 0.75 });
    expect(atThreeQuarters.byLayer.get("img")!.dx).toBe(10 + (0 - 10) * 0.5);

    // Exact boundaries hold at the stop's own value.
    expect(resolveTracks(layers, [], { t: 0 }).byLayer.get("img")!.dx).toBe(0);
    expect(resolveTracks(layers, [], { t: 1 }).byLayer.get("img")!.dx).toBe(0);
  });

  test("holds before the first stop and after the last", () => {
    const track: Track = {
      property: "dy",
      stops: [
        { t: 0.2, value: 3, clock: "pose" },
        { t: 0.8, value: 9, clock: "pose" },
      ],
    };
    const layers: TrackedLayer[] = [{ id: "img", kind: "image", tracks: [track] }];

    expect(resolveTracks(layers, [], { t: 0 }).byLayer.get("img")!.dy).toBe(3);
    expect(resolveTracks(layers, [], { t: 0.1 }).byLayer.get("img")!.dy).toBe(3);
    expect(resolveTracks(layers, [], { t: 1 }).byLayer.get("img")!.dy).toBe(9);
    expect(resolveTracks(layers, [], { t: 0.9 }).byLayer.get("img")!.dy).toBe(9);
    // Inside the stops: default easing, exact float.
    const mid = resolveTracks(layers, [], { t: 0.5 });
    expect(mid.byLayer.get("img")!.dy).toBe(3 + (9 - 3) * easeOutCubic(0.5));
  });

  test("beat clock resets per beat, and pose clock ignores which beat is current", () => {
    const timeline: CopyTimeline = {
      beats: [
        { text: "A", weight: 1 },
        { text: "B", weight: 1 },
      ],
      transition: "cut",
      keyBeat: 1,
    };
    const resolved = resolveTimeline(timeline, 10);
    const track: Track = {
      property: "dy",
      stops: [
        { t: 0, value: 0, clock: "beat" },
        { t: 1, value: 20, clock: "beat" },
      ],
    };
    const scaleTrack: Track = {
      property: "scale",
      stops: [
        { t: 0, value: 1, clock: "pose" },
        { t: 1, value: 2, clock: "pose" },
      ],
    };
    const layers: TrackedLayer[] = [{ id: "txt", kind: "static-text", tracks: [track, scaleTrack] }];

    // Global t = 0.25, quarter-way into beat A's own [0, 0.5) window: beat-local
    // progress is 0.5, same as t = 0.75 a quarter-way into beat B's [0.5, 1]
    // window -- the beat clock RESETS each beat rather than reading t directly.
    const inA = resolveTracks(layers, resolved, { t: 0.25, copyT: 0.25 });
    const inB = resolveTracks(layers, resolved, { t: 0.75, copyT: 0.75 });
    expect(inA.copy).toHaveLength(1);
    expect(inB.copy).toHaveLength(1);
    expect(inA.copy[0]!.pose.dy).toBe(0 + (20 - 0) * easeOutCubic(0.5));
    expect(inB.copy[0]!.pose.dy).toBe(inA.copy[0]!.pose.dy);

    // The pose clock reads clocks.t directly -- it differs between the two
    // calls above (0.25 vs 0.75) even though the beat clock does not.
    expect(inA.copy[0]!.pose.scale).toBe(1 + (2 - 1) * easeOutCubic(0.25));
    expect(inB.copy[0]!.pose.scale).toBe(1 + (2 - 1) * easeOutCubic(0.75));
    expect(inA.copy[0]!.pose.scale).not.toBe(inB.copy[0]!.pose.scale);
  });

  test("a ground layer's pose is unaffected by which beat is current (K1b review fix round 2)", () => {
    // image/video may only carry pose-clock tracks (the boundary refuses
    // beat/effect on them) -- so byLayer folds at clocks.t alone, and a
    // crossfade rotating the current beat must change nothing about it.
    const timeline: CopyTimeline = {
      beats: [
        { text: "A", weight: 1 },
        { text: "B", weight: 1 },
      ],
      transition: "cut",
      keyBeat: 1,
    };
    const resolved = resolveTimeline(timeline, 10);
    const track: Track = {
      property: "scale",
      stops: [
        { t: 0, value: 1, clock: "pose" },
        { t: 1, value: 2, clock: "pose" },
      ],
    };
    const layers: TrackedLayer[] = [{ id: "img", kind: "image", tracks: [track] }];

    // Same global t (0.5); copyT selects a different current beat each time.
    const duringA = resolveTracks(layers, resolved, { t: 0.5, copyT: 0.2 });
    const duringB = resolveTracks(layers, resolved, { t: 0.5, copyT: 0.8 });
    expect(duringA.byLayer.get("img")).toEqual(duringB.byLayer.get("img"));
    expect(duringA.byLayer.get("img")!.scale).toBe(1 + (2 - 1) * easeOutCubic(0.5));
  });

  test("copyT defaults to t when absent, matching draw()'s own copyT ?? t", () => {
    const timeline: CopyTimeline = {
      beats: [
        { text: "A", weight: 1 },
        { text: "B", weight: 1 },
      ],
      transition: "cut",
      keyBeat: 1,
    };
    const resolved = resolveTimeline(timeline, 10);
    const layers: TrackedLayer[] = [{ id: "txt", kind: "static-text", tracks: [constant("dy", 42)] }];

    // No copyT given -- must select beat B by t alone (t = 0.75 falls in B's
    // [0.5, 1] window), not fall back to beat A.
    const result = resolveTracks(layers, resolved, { t: 0.75 });
    expect(result.copy).toHaveLength(1);
    expect(result.copy[0]!.beat).toBe(resolved[1]);
  });

  test("effect clock reads clocks.effectT when given, not the beat-local fallback", () => {
    const timeline: CopyTimeline = {
      beats: [
        { text: "A", weight: 1 },
        { text: "B", weight: 1 },
      ],
      transition: "cut",
      keyBeat: 1,
    };
    const resolved = resolveTimeline(timeline, 10);
    const track: Track = {
      property: "opacity",
      stops: [
        { t: 0, value: 0, clock: "effect" },
        { t: 1, value: 1, clock: "effect" },
      ],
    };
    const layers: TrackedLayer[] = [{ id: "txt", kind: "static-text", tracks: [track] }];

    // Beat-local progress here is 0.5 (t = 0.25 into A's [0, 0.5) window), but
    // an explicit effectT of 0.9 must win over that fallback.
    const result = resolveTracks(layers, resolved, { t: 0.25, copyT: 0.25, effectT: 0.9 });
    expect(result.copy[0]!.pose.opacity).toBe(easeOutCubic(0.9));
    expect(result.copy[0]!.pose.opacity).not.toBe(easeOutCubic(0.5));
  });
});

describe("resolveTracks — the legacy (timeline-less) path", () => {
  test("local = t exactly, and beatAt is never called (an empty resolved list throws if it is)", () => {
    // A beat-clock track needs a text-kind layer (K1b review fix round 2) --
    // beat/effect on image/video is refused at the boundary, since a ground
    // layer has no per-beat multiplicity of its own.
    const track: Track = {
      property: "dy",
      stops: [
        { t: 0, value: 0, clock: "beat" },
        { t: 1, value: 100, clock: "beat" },
      ],
    };
    const layers: TrackedLayer[] = [{ id: "txt", kind: "static-text", tracks: [track] }];

    // beatAt throws on an empty list -- if resolveTracks called it here, this
    // would throw instead of returning.
    expect(() => resolveTracks(layers, [], { t: 0.4 })).not.toThrow();
    const result = resolveTracks(layers, [], { t: 0.4 });
    expect(result.copy[0]!.pose.dy).toBe(0 + (100 - 0) * easeOutCubic(0.4));
  });
});

describe("resolveTracks — an effect-clock reproduction fixture (textEffectPose's fade-in, T6)", () => {
  test("opacity stops at t = 0 and t = 0.3 with the default easing equal easeOutCubic(clamp01(local / 0.3)) for a sample of t", () => {
    const track: Track = {
      property: "opacity",
      stops: [
        { t: 0, value: 0, clock: "effect" },
        { t: 0.3, value: 1, clock: "effect" },
      ],
    };
    const layers: TrackedLayer[] = [{ id: "txt", kind: "static-text", tracks: [track] }];

    for (const t of [0, 0.05, 0.15, 0.29, 0.3, 0.5, 0.9, 1]) {
      const local = t; // the legacy path's own definition (K-D8)
      const clamped = local < 0 ? 0 : local > 1 ? 1 : local;
      const expected = easeOutCubic(Math.min(1, clamped / 0.3));
      const result = resolveTracks(layers, [], { t });
      expect(result.copy[0]!.pose.opacity).toBe(expected);
    }
  });
});

describe("resolveTracks — fold order (K-D9)", () => {
  test("two dy tracks add", () => {
    const layers: TrackedLayer[] = [
      { id: "img", kind: "image", tracks: [constant("dy", 5), constant("dy", 7)] },
    ];
    expect(resolveTracks(layers, [], { t: 0 }).byLayer.get("img")!.dy).toBe(12);
  });

  test("three opacity tracks multiply in DECLARATION order -- a fixture where reversing the fold changes the float, because float multiplication is associative in real arithmetic but not bit-for-bit in IEEE-754 (a two-operand product is exactly commutative, so this needs three)", () => {
    const forward = 1 * 0.1 * 0.2 * 0.3;
    const reverse = 1 * 0.3 * 0.2 * 0.1;
    expect(forward).not.toBe(reverse); // the fixture actually distinguishes the two orders

    const layers: TrackedLayer[] = [
      {
        id: "img",
        kind: "image",
        tracks: [constant("opacity", 0.1), constant("opacity", 0.2), constant("opacity", 0.3)],
      },
    ];
    expect(resolveTracks(layers, [], { t: 0 }).byLayer.get("img")!.opacity).toBe(forward);
  });
});

describe("resolveTracks — copy is one pose per (beat, mix), not per text layer", () => {
  test("a crossfade instant yields two copy entries with complementary mix, and neither pose includes mix", () => {
    const timeline: CopyTimeline = {
      beats: [
        { text: "A", weight: 1 },
        { text: "B", weight: 1 },
      ],
      transition: "fade",
      keyBeat: 1,
    };
    const resolved = resolveTimeline(timeline, 10);
    const fadeInT = resolved[1]!.fadeInT;
    expect(fadeInT).toBeGreaterThan(0);
    const copyT = resolved[1]!.startT + fadeInT / 2; // inside beat B's incoming fade
    const pair = beatAt(resolved, copyT);
    expect(pair.incoming).toBeDefined();

    const layers: TrackedLayer[] = [{ id: "txt", kind: "static-text", tracks: [constant("opacity", 0.5)] }];
    const result = resolveTracks(layers, resolved, { t: copyT, copyT });

    expect(result.copy).toHaveLength(2);
    expect(result.copy[0]!.mix).toBe(1 - pair.mix);
    expect(result.copy[1]!.mix).toBe(pair.mix);
    expect(result.copy[0]!.beat).toBe(pair.current);
    expect(result.copy[1]!.beat).toBe(pair.incoming);
    for (const entry of result.copy) {
      expect(entry.pose).not.toHaveProperty("mix");
    }
  });

  test("two text layers fold into ONE copy pose, not two -- copy's length is the number of live beats, never the number of text layers", () => {
    const layers: TrackedLayer[] = [
      { id: "static", kind: "static-text", tracks: [constant("dy", 3)] },
      { id: "animated", kind: "animated-text", tracks: [constant("dy", 4)] },
      { id: "img", kind: "image", tracks: [constant("dy", 99)] },
    ];
    const result = resolveTracks(layers, [], { t: 0 });
    expect(result.copy).toHaveLength(1);
    expect(result.copy[0]!.pose.dy).toBe(7); // 3 + 4, folded across layers in declaration order
    expect(result.byLayer.get("img")!.dy).toBe(99); // unaffected, and kept separate
  });

  test("no text layer at all still emits one identity copy entry per pair", () => {
    const layers: TrackedLayer[] = [{ id: "img", kind: "image", tracks: [constant("dy", 99)] }];
    const result = resolveTracks(layers, [], { t: 0 });
    expect(result.copy).toHaveLength(1);
    expect(result.copy[0]!.beat).toBe(IMPLICIT_BEAT);
    expect(result.copy[0]!.mix).toBe(1);
    expect(result.copy[0]!.pose).toEqual(IDENTITY_POSE);
  });
});

describe("resolveTracks — absent, disabled and trackless layers contribute the identity pose", () => {
  test("disabled: a defined, non-empty tracks list is ignored", () => {
    const layers: TrackedLayer[] = [
      { id: "img", kind: "image", enabled: false, tracks: [constant("dx", 50)] },
    ];
    expect(resolveTracks(layers, [], { t: 0.5 }).byLayer.get("img")).toEqual(IDENTITY_POSE);
  });

  test("trackless: tracks absent, or an empty array", () => {
    const layers: TrackedLayer[] = [
      { id: "a", kind: "video" },
      { id: "b", kind: "video", tracks: [] },
    ];
    const result = resolveTracks(layers, [], { t: 0.5 });
    expect(result.byLayer.get("a")).toEqual(IDENTITY_POSE);
    expect(result.byLayer.get("b")).toEqual(IDENTITY_POSE);
  });

  test("a disabled text layer contributes nothing to the copy fold", () => {
    const layers: TrackedLayer[] = [
      { id: "txt", kind: "static-text", enabled: false, tracks: [constant("opacity", 0)] },
    ];
    expect(resolveTracks(layers, [], { t: 0.5 }).copy[0]!.pose).toEqual(IDENTITY_POSE);
  });

  test("absent: a layer id resolveTracks never saw reads as identity through poseOf", () => {
    const result = resolveTracks([], [], { t: 0.5 });
    expect(result.byLayer.get("nonexistent")).toBeUndefined();
    expect(poseOf(result, "nonexistent")).toEqual(IDENTITY_POSE);
  });
});
