import { describe, test, expect } from "vitest";
import {
  beatAt,
  MAX_BEATS,
  MAX_WEIGHT,
  MIN_DWELL_SEC,
  resolveTimeline,
  timelineProblem,
  type CopyTimeline,
  type CopyBeat,
} from "../CopyTimeline.vo.js";
import { DEFAULT_DURATION_SEC } from "../variation-defaults.js";

const A = "New season, new kit";
const B = "Built for the cold";
const C = "Shop now";

const timeline = (beats: readonly CopyBeat[], transition: "cut" | "fade" = "fade"): CopyTimeline => ({
  beats,
  transition,
  keyBeat: 1,
});

describe("resolveTimeline", () => {
  test("produces identical t-window boundaries at every duration", () => {
    const a = resolveTimeline(timeline([{ text: A, weight: 2 }, { text: B, weight: 3 }, { text: C, weight: 2 }]), 5);
    const b = resolveTimeline(timeline([{ text: A, weight: 2 }, { text: B, weight: 3 }, { text: C, weight: 2 }]), 10);
    const c = resolveTimeline(timeline([{ text: A, weight: 2 }, { text: B, weight: 3 }, { text: C, weight: 2 }]), 15);
    for (let i = 0; i < a.length; i += 1) {
      expect(a[i].startT).toBeCloseTo(b[i].startT, 12);
      expect(a[i].endT).toBeCloseTo(b[i].endT, 12);
      expect(a[i].startT).toBeCloseTo(c[i].startT, 12);
      expect(a[i].endT).toBeCloseTo(c[i].endT, 12);
    }
  });

  test("weights resolve to proportional windows with the last closed at 1", () => {
    const resolved = resolveTimeline(
      timeline([{ text: A, weight: 2 }, { text: B, weight: 3 }, { text: C, weight: 2 }]),
      5,
    );
    expect(resolved.map((r) => r.startT)).toEqual([0, 2 / 7, 5 / 7]);
    expect(resolved.map((r) => r.endT)).toEqual([2 / 7, 5 / 7, 1]);
    expect(resolved.map((r) => r.text)).toEqual([A, B, C]);
  });

  test("fadeInT is 0 for a cut timeline and for the first beat, and scales with duration", () => {
    const cut = resolveTimeline(timeline([{ text: A, weight: 2 }, { text: B, weight: 3 }], "cut"), 5);
    expect(cut.map((r) => r.fadeInT)).toEqual([0, 0]);

    const fade5 = resolveTimeline(timeline([{ text: A, weight: 2 }, { text: B, weight: 3 }], "fade"), 5);
    expect(fade5[0].fadeInT).toBe(0);
    const fade15 = resolveTimeline(timeline([{ text: A, weight: 2 }, { text: B, weight: 3 }], "fade"), 15);
    // The fade is authored in seconds, so it occupies more of t in a shorter clip (D2/D9).
    expect(fade5[1].fadeInT).toBeGreaterThan(fade15[1].fadeInT);
    expect(fade15[1].fadeInT).toBeGreaterThan(0);
  });

  test("fade width is bounded by 25% of the shorter adjacent beat and 0.4 s", () => {
    // One very heavy beat next to a light one: the 25%-of-shorter bound pins the fade.
    const resolved = resolveTimeline(
      timeline([{ text: A, weight: 1 }, { text: B, weight: 100 }], "fade"),
      10,
    );
    const shorterSec = (10 * 1) / 101;
    const expected = Math.min(0.4, 0.25 * shorterSec) / 10;
    expect(resolved[1].fadeInT).toBeCloseTo(expected, 12);
  });
});

describe("beatAt", () => {
  const resolved = resolveTimeline(
    timeline([{ text: A, weight: 2 }, { text: B, weight: 3 }, { text: C, weight: 2 }]),
    5,
  );
  const boundaries = [0, 2 / 7, 5 / 7, 1];

  test("is total: selects a beat at every boundary and returns the last at t = 1 with mix 0", () => {
    // At the start of the first beat.
    expect(beatAt(resolved, 0).current.text).toBe(A);
    // At an interior boundary, the next beat fades in from mix 0.
    const atB = beatAt(resolved, 2 / 7);
    expect(atB.current.text).toBe(A);
    expect(atB.incoming?.text).toBe(B);
    expect(atB.mix).toBeCloseTo(0, 12);
    const atC = beatAt(resolved, 5 / 7);
    expect(atC.current.text).toBe(B);
    expect(atC.incoming?.text).toBe(C);
    expect(atC.mix).toBeCloseTo(0, 12);
    // t = 1 is the last beat, past the fade, with no incoming.
    const last = beatAt(resolved, 1);
    expect(last.current.text).toBe(C);
    expect(last.incoming).toBeUndefined();
    expect(last.mix).toBe(0);
  });

  test("reports the outgoing and incoming pair with a rising mix inside every fade", () => {
    for (let i = 1; i < resolved.length; i += 1) {
      const mid = resolved[i].startT + resolved[i].fadeInT / 2;
      const at = beatAt(resolved, mid);
      expect(at.current.text).toBe(resolved[i - 1].text);
      expect(at.incoming?.text).toBe(resolved[i].text);
      expect(at.mix).toBeCloseTo(0.5, 3);
    }
  });

  test("selects the fixed beat with mix 0 outside any fade and past a fade end", () => {
    // Beat 1's interior, well past its incoming fade.
    const atB = beatAt(resolved, (2 / 7 + 5 / 7) / 2);
    expect(atB.current.text).toBe(B);
    expect(atB.incoming).toBeUndefined();
    expect(atB.mix).toBe(0);
    // Beat 0's whole window has no incoming fade.
    const atA = beatAt(resolved, 1 / 7);
    expect(atA.current.text).toBe(A);
    expect(atA.incoming).toBeUndefined();
    expect(atA.mix).toBe(0);
  });

  test("with a cut timeline no beat ever fades in", () => {
    const cut = resolveTimeline(timeline([{ text: A, weight: 2 }, { text: B, weight: 3 }], "cut"), 5);
    expect(beatAt(cut, 0).incoming).toBeUndefined();
    expect(beatAt(cut, 0.5).incoming).toBeUndefined();
    expect(beatAt(cut, 1).incoming).toBeUndefined();
  });

  test("a single beat is equivalent to no timeline: the same text at every t", () => {
    const single = resolveTimeline(timeline([{ text: A, weight: 1 }]), 5);
    expect(single).toEqual([{ text: A, startT: 0, endT: 1, fadeInT: 0 }]);
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const at = beatAt(single, t);
      expect(at.current.text).toBe(A);
      expect(at.incoming).toBeUndefined();
      expect(at.mix).toBe(0);
    }
  });
});

describe("timelineProblem", () => {
  test.each([
    ["empty beats", timeline([], "fade"), [5], undefined],
    ["more than MAX_BEATS", timeline(Array.from({ length: MAX_BEATS + 1 }, () => ({ text: A, weight: 1 }))), [5], /more than/],
    ["non-integer weight", timeline([{ text: A, weight: 1.5 }]), [5], /must be an integer/],
    ["weight below 1", timeline([{ text: A, weight: 0 }]), [5], /\[1, 20\]/],
    ["weight above MAX_WEIGHT", timeline([{ text: A, weight: MAX_WEIGHT + 1 }]), [5], /\[1, 20\]/],
    ["astronomical weight that is still an integer", timeline([{ text: A, weight: 1e308 }]), [5], /\[1, 20\]/],
  ])("rejects %s", (_label, t, durations, _match) => {
    expect(timelineProblem(t, durations)).toBeDefined();
  });

  test("rejects a keyBeat out of range, naming the beat count", () => {
    const t: CopyTimeline = { beats: [{ text: A, weight: 2 }, { text: B, weight: 2 }], transition: "fade", keyBeat: 3 };
    expect(timelineProblem(t, [5])).toMatch(/keyBeat/);
    expect(timelineProblem(t, [5])).toMatch(/\[1, 2\]/);
  });

  test("rejects a keyBeat below 1", () => {
    const t: CopyTimeline = { beats: [{ text: A, weight: 2 }, { text: B, weight: 2 }], transition: "fade", keyBeat: 0 };
    expect(timelineProblem(t, [5])).toMatch(/keyBeat/);
  });

  test("returns undefined for a structurally valid timeline whose beats clear the floor", () => {
    const t: CopyTimeline = {
      beats: [{ text: A, weight: 2 }, { text: B, weight: 3 }, { text: C, weight: 2 }],
      transition: "fade",
      keyBeat: 2,
    };
    expect(timelineProblem(t, [5, 15])).toBeUndefined();
  });

  test("enforces the floor per beat, not per average (D3): [5,1,1] at 5s fails", () => {
    const t = timeline([{ text: A, weight: 5 }, { text: B, weight: 1 }, { text: C, weight: 1 }], "fade");
    const problem = timelineProblem(t, [5]);
    // The average would pass (3 * MIN_DWELL_SEC = 3.6 <= 5), but the thinnest beat
    // gets 5 * 1 / 7 = 0.71 s, which the per-beat rule must reject.
    expect(3 * MIN_DWELL_SEC).toBeLessThanOrEqual(5);
    expect(problem).toBeDefined();
    expect(problem).toMatch(/readability floor/);
  });

  test("an empty duration axis falls back to DEFAULT_DURATION_SEC, not an infinite floor", () => {
    // With durations = [] a vacuous min([]) = Infinity would let [5,1,1] pass; the
    // fallback makes the thinnest beat 6 * 1 / 7 = 0.86 s and rejects it.
    const t = timeline([{ text: A, weight: 5 }, { text: B, weight: 1 }, { text: C, weight: 1 }], "fade");
    expect(DEFAULT_DURATION_SEC).toBe(6);
    expect(timelineProblem(t, [])).toBeDefined();
    // A single beat can always clear the floor at the default duration.
    expect(timelineProblem(timeline([{ text: A, weight: 1 }]), [])).toBeUndefined();
  });

  test("compares the floor with a tolerance so float drift at the boundary does not falsely reject", () => {
    // 3 * MIN_DWELL_SEC = 3.5999999999999996; a [1,1,1] timeline dwells exactly on the
    // floor at that duration, so it must pass despite reading a hair under 1.2.
    const t = timeline([{ text: A, weight: 1 }, { text: B, weight: 1 }, { text: C, weight: 1 }], "fade");
    expect(3 * MIN_DWELL_SEC).toBe(3.5999999999999996);
    expect(timelineProblem(t, [3 * MIN_DWELL_SEC])).toBeUndefined();
    // Just below the floor (3.5 / 3 = 1.1667) must still fail.
    expect(timelineProblem(t, [3.5])).toBeDefined();
  });
});

describe("degenerate inputs fail loudly or not at all", () => {
  test("a zero-length clip has no room to fade, rather than a NaN width", () => {
    // `0 / 0` is NaN, and every comparison against NaN is false — so a NaN fadeInT does
    // not throw, it makes the crossfade silently vanish.
    const resolved = resolveTimeline(
      { beats: [{ text: "a", weight: 1 }, { text: "b", weight: 1 }], transition: "fade", keyBeat: 1 },
      0,
    );
    expect(resolved.every((beat) => Number.isFinite(beat.fadeInT))).toBe(true);
    expect(resolved[1].fadeInT).toBe(0);
  });

  test("resolveTimeline returns an empty list for empty beats, without dividing by zero", () => {
    // the loop never runs, so the zero total is never a divisor
    expect(resolveTimeline({ beats: [], transition: "cut", keyBeat: 1 }, 6)).toEqual([]);
  });

  test("beatAt refuses an empty timeline by name instead of returning undefined", () => {
    expect(() => beatAt([], 0)).toThrow(/empty/);
  });
});
