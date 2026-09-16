import { describe, test, expect } from "vitest";
import { easeOutCubic } from "../easing.js";
import { poseOf, resolveTracks, type TrackedLayer } from "../resolve-tracks.js";
import { accentWipeFraction, copyMotionTracks, groundMotionTracks } from "../motion-tracks.js";

/**
 * K2's per-kind equivalence proof: the expansion's tracks, resolved through
 * `resolveTracks`, reproduce the compositor's OLD per-kind formulas —
 * `kenBurnsScale`'s `1 + KEN_BURNS_ZOOM * (1 - eased)` / `... * eased` and
 * the old `riseDy`/`riseAlpha` — computed independently here from the old
 * formula, not by calling the new module a second time.
 *
 * At the two stops themselves (t = 0, t = 1 — one of which is every kind's
 * `restT`) `resolveTracks` returns the stop's own value with no arithmetic,
 * so the match is EXACT (`toBe`). At an interior `t` the resolver's fold
 * reassociates the same two terms (`a + (b - a) * eased` instead of
 * `1 + Z * (1 - eased)`), which can differ from the old formula in the last
 * bit of a double — asserted with `toBeCloseTo` here, and proven not to move
 * a rendered pixel by `NodeCanvasCompositor.motion-goldens.test.ts` (48
 * cells) and the mp4 byte golden, which is the real proof for a byte-identity
 * gate: two mathematically-identical, differently-associated floating-point
 * expressions, not a similarity judgement.
 */

const KEN_BURNS_ZOOM = 0.08;
const HEADLINE_RISE_OFFSET_FRACTION = 0.12;
const SAMPLE_TS = [0, 0.25, 0.5, 0.75, 1] as const;

function groundScaleAt(layerId: string, motion: Parameters<typeof groundMotionTracks>[0], t: number): number {
  const layers: TrackedLayer[] = [{ id: layerId, kind: "image", tracks: groundMotionTracks(motion) }];
  return poseOf(resolveTracks(layers, [], { t }), layerId).scale;
}

function copyPoseAt(motion: Parameters<typeof copyMotionTracks>[0], height: number, t: number) {
  const layers: TrackedLayer[] = [{ id: "copy", kind: "static-text", tracks: copyMotionTracks(motion, height) }];
  const resolved = resolveTracks(layers, [], { t });
  return resolved.copy[0]!.pose;
}

describe("groundMotionTracks — ken-burns as a pose-clock scale track (K2)", () => {
  test.each(SAMPLE_TS)("ken-burns-in at t=%s matches the old 1 + Z * (1 - eased) at the stops, close everywhere", (t) => {
    const eased = easeOutCubic(t);
    const expected = 1 + KEN_BURNS_ZOOM * (1 - eased);
    const actual = groundScaleAt("img", "ken-burns-in", t);
    if (t === 0 || t === 1) expect(actual).toBe(expected);
    else expect(actual).toBeCloseTo(expected, 12);
  });

  test.each(SAMPLE_TS)("ken-burns-out at t=%s matches the old 1 + Z * eased at the stops, close everywhere", (t) => {
    const eased = easeOutCubic(t);
    const expected = 1 + KEN_BURNS_ZOOM * eased;
    const actual = groundScaleAt("img", "ken-burns-out", t);
    if (t === 0 || t === 1) expect(actual).toBe(expected);
    else expect(actual).toBeCloseTo(expected, 12);
  });

  test.each([undefined, "headline-rise", "accent-wipe"] as const)(
    "%s emits no ground track — identity scale",
    (motion) => {
      expect(groundMotionTracks(motion)).toEqual([]);
      expect(groundScaleAt("img", motion, 0.5)).toBe(1);
    },
  );
});

describe("copyMotionTracks — headline-rise as beat-clock opacity + dy tracks (K2)", () => {
  const height = 1080;

  test.each(SAMPLE_TS)("opacity at local=%s matches the old riseAlpha exactly (0 + (1 - 0) * eased has no rounding)", (t) => {
    const eased = easeOutCubic(t);
    expect(copyPoseAt("headline-rise", height, t).opacity).toBe(eased);
  });

  test.each(SAMPLE_TS)("dy at local=%s matches the old (1 - eased) * C at the stops, close everywhere", (t) => {
    const eased = easeOutCubic(t);
    const expected = (1 - eased) * HEADLINE_RISE_OFFSET_FRACTION * height;
    const actual = copyPoseAt("headline-rise", height, t).dy;
    if (t === 0 || t === 1) expect(actual).toBe(expected);
    else expect(actual).toBeCloseTo(expected, 9);
  });

  test.each([undefined, "ken-burns-in", "ken-burns-out", "accent-wipe"] as const)(
    "%s emits no copy track — identity pose (dy 0, opacity 1)",
    (motion) => {
      expect(copyMotionTracks(motion, height)).toEqual([]);
      const pose = copyPoseAt(motion, height, 0.5);
      expect(pose.dy).toBe(0);
      expect(pose.opacity).toBe(1);
    },
  );
});

describe("accentWipeFraction — the one kind K2 does not turn into a track", () => {
  test.each(SAMPLE_TS)("accent-wipe at eased=%s is exactly the eased value", (eased) => {
    expect(accentWipeFraction("accent-wipe", eased)).toBe(eased);
  });

  test.each([undefined, "ken-burns-in", "ken-burns-out", "headline-rise"] as const)(
    "%s is always 1, regardless of eased",
    (motion) => {
      expect(accentWipeFraction(motion, 0)).toBe(1);
      expect(accentWipeFraction(motion, 0.42)).toBe(1);
      expect(accentWipeFraction(motion, 1)).toBe(1);
    },
  );

  // Mutation (b) target: dropping the wipe's progress (a constant 1 instead
  // of `motion === "accent-wipe" ? eased : 1`) must fail here.
  test("accent-wipe is NOT always 1 — the wipe actually progresses", () => {
    expect(accentWipeFraction("accent-wipe", 0.3)).not.toBe(1);
  });
});
