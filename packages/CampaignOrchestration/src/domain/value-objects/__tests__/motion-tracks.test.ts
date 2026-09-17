import { describe, test, expect } from "vitest";
import type { CanvasSpec } from "../aspect-ratios.js";
import { CREATIVE_GEOMETRY } from "../creative-geometry.js";
import type { TextEffectKind } from "../creative-style.js";
import { easeOutCubic } from "../easing.js";
import { poseOf, resolveTracks, type TrackedLayer } from "../resolve-tracks.js";
import {
  accentWipeFraction,
  copyMotionTracks,
  groundMotionTracks,
  textEffectTracks,
} from "../motion-tracks.js";

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

function groundScaleAt(
  layerId: string,
  motion: Parameters<typeof groundMotionTracks>[0],
  t: number,
): number {
  const layers: TrackedLayer[] = [
    { id: layerId, kind: "image", tracks: groundMotionTracks(motion) },
  ];
  return poseOf(resolveTracks(layers, [], { t }), layerId).scale;
}

function copyPoseAt(motion: Parameters<typeof copyMotionTracks>[0], height: number, t: number) {
  const layers: TrackedLayer[] = [
    { id: "copy", kind: "static-text", tracks: copyMotionTracks(motion, height) },
  ];
  const resolved = resolveTracks(layers, [], { t });
  return resolved.copy[0]!.pose;
}

describe("groundMotionTracks — ken-burns as a pose-clock scale track (K2)", () => {
  test.each(SAMPLE_TS)(
    "ken-burns-in at t=%s matches the old 1 + Z * (1 - eased) at the stops, close everywhere",
    (t) => {
      const eased = easeOutCubic(t);
      const expected = 1 + KEN_BURNS_ZOOM * (1 - eased);
      const actual = groundScaleAt("img", "ken-burns-in", t);
      if (t === 0 || t === 1) expect(actual).toBe(expected);
      else expect(actual).toBeCloseTo(expected, 12);
    },
  );

  test.each(SAMPLE_TS)(
    "ken-burns-out at t=%s matches the old 1 + Z * eased at the stops, close everywhere",
    (t) => {
      const eased = easeOutCubic(t);
      const expected = 1 + KEN_BURNS_ZOOM * eased;
      const actual = groundScaleAt("img", "ken-burns-out", t);
      if (t === 0 || t === 1) expect(actual).toBe(expected);
      else expect(actual).toBeCloseTo(expected, 12);
    },
  );

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

  test.each(SAMPLE_TS)(
    "opacity at local=%s matches the old riseAlpha exactly (0 + (1 - 0) * eased has no rounding)",
    (t) => {
      const eased = easeOutCubic(t);
      expect(copyPoseAt("headline-rise", height, t).opacity).toBe(eased);
    },
  );

  test.each(SAMPLE_TS)(
    "dy at local=%s matches the old (1 - eased) * C at the stops, close everywhere",
    (t) => {
      const eased = easeOutCubic(t);
      const expected = (1 - eased) * HEADLINE_RISE_OFFSET_FRACTION * height;
      const actual = copyPoseAt("headline-rise", height, t).dy;
      if (t === 0 || t === 1) expect(actual).toBe(expected);
      else expect(actual).toBeCloseTo(expected, 9);
    },
  );

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

/**
 * K3's per-effect equivalence proof, mirroring K2's: the expansion's tracks,
 * resolved through `resolveTracks`, reproduce the compositor's OLD
 * `textEffectPose` formulas — computed independently here from the old
 * formula (`easeOutCubic(clamp01(local / entranceFraction))`, then each
 * kind's own `TEXT_EFFECT_REST` spread), never by calling the new module a
 * second time.
 *
 * At the two stops themselves (`t = 0`, `t = entranceFraction`) the resolver
 * returns the stop's own value with no arithmetic, so the match is EXACT
 * (`toBe`). At an interior `local` the fold reassociates the same terms,
 * which can differ from the old formula in the last bit of a double for
 * `rise-in`/`slide-in`/`scale-in` — asserted with `toBeCloseTo` — while
 * `fade-in`'s `0 + (1 - 0) * eased` has no rounding at all and stays exact
 * everywhere (mirroring `headline-rise`'s own opacity track, K2). The real
 * proof for a byte-identity gate is the compositor's goldens (unchanged), not
 * this closeness assertion.
 */
const EFFECT = CREATIVE_GEOMETRY.textEffect;
const spec1x1: CanvasSpec = { ratio: "1:1" };
const WIDTH = 1080;
const HEIGHT = 1080;
const EFFECT_SAMPLE_LOCALS = [0, EFFECT.entranceFraction / 2, EFFECT.entranceFraction, 1] as const;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function oldSettled(local: number): number {
  return easeOutCubic(clamp01(local / EFFECT.entranceFraction));
}

function effectPoseAt(effect: TextEffectKind | undefined, local: number) {
  const layers: TrackedLayer[] = [
    { id: "copy", kind: "static-text", tracks: textEffectTracks(effect, spec1x1, WIDTH, HEIGHT) },
  ];
  const resolved = resolveTracks(layers, [], { t: local });
  return resolved.copy[0]!.pose;
}

describe("textEffectTracks — the four text effects as effect-clock tracks (K3)", () => {
  test.each(EFFECT_SAMPLE_LOCALS)(
    "fade-in at local=%s matches the old settled alpha exactly everywhere",
    (local) => {
      const expected = oldSettled(local);
      expect(effectPoseAt("fade-in", local).opacity).toBe(expected);
    },
  );

  test.each(EFFECT_SAMPLE_LOCALS)(
    "rise-in at local=%s matches the old (1 - settled) * C at the stops, close everywhere",
    (local) => {
      const settled = oldSettled(local);
      const expected = (1 - settled) * EFFECT.riseOffsetFraction * HEIGHT;
      const actual = effectPoseAt("rise-in", local).dy;
      if (local === 0 || local === EFFECT.entranceFraction) expect(actual).toBe(expected);
      else expect(actual).toBeCloseTo(expected, 9);
    },
  );

  test.each(EFFECT_SAMPLE_LOCALS)(
    "slide-in at local=%s matches the old (1 - settled) * C at the stops, close everywhere",
    (local) => {
      const settled = oldSettled(local);
      const expected = (1 - settled) * EFFECT.slideOffsetFraction * WIDTH; // scaleBasis(1:1, w, h) === w
      const actual = effectPoseAt("slide-in", local).dx;
      if (local === 0 || local === EFFECT.entranceFraction) expect(actual).toBe(expected);
      else expect(actual).toBeCloseTo(expected, 9);
    },
  );

  test.each(EFFECT_SAMPLE_LOCALS)(
    "scale-in at local=%s matches the old 1 - (1 - settled) * A at the stops, close everywhere",
    (local) => {
      const settled = oldSettled(local);
      const expected = 1 - (1 - settled) * EFFECT.scaleAmplitude;
      const actual = effectPoseAt("scale-in", local).scale;
      if (local === 0 || local === EFFECT.entranceFraction) expect(actual).toBe(expected);
      else expect(actual).toBeCloseTo(expected, 12);
    },
  );

  test.each([undefined] as const)("%s emits no effect track — identity pose", (effect) => {
    expect(textEffectTracks(effect, spec1x1, WIDTH, HEIGHT)).toEqual([]);
    const pose = effectPoseAt(effect, 0.1);
    expect(pose).toEqual({ dx: 0, dy: 0, opacity: 1, scale: 1 });
  });

  describe("the settled pose: past the entrance window every kind is the identity for its property", () => {
    const PAST = [EFFECT.entranceFraction + 0.1, 1] as const;

    test.each(PAST)("fade-in at local=%s is fully opaque", (local) => {
      expect(effectPoseAt("fade-in", local).opacity).toBe(1);
    });
    test.each(PAST)("rise-in at local=%s has settled to dy = 0", (local) => {
      expect(effectPoseAt("rise-in", local).dy).toBe(0);
    });
    test.each(PAST)("slide-in at local=%s has settled to dx = 0", (local) => {
      expect(effectPoseAt("slide-in", local).dx).toBe(0);
    });
    test.each(PAST)("scale-in at local=%s has settled to scale = 1", (local) => {
      expect(effectPoseAt("scale-in", local).scale).toBe(1);
    });
  });

  // Mutation (a) target: swapping two effects' expansions (e.g. fade-in's
  // property for rise-in's) must fail the per-effect equivalence tests above.
  // Mutation (b) target: dropping the entrance-window stop (only `t = 0`)
  // means the property never settles — this test would then observe a
  // non-identity value past the window.
  test("fade-in and rise-in do not share a shape — a swapped expansion is observable", () => {
    const fade = textEffectTracks("fade-in", spec1x1, WIDTH, HEIGHT);
    const rise = textEffectTracks("rise-in", spec1x1, WIDTH, HEIGHT);
    expect(fade[0]?.property).toBe("opacity");
    expect(rise[0]?.property).toBe("dy");
  });
});
