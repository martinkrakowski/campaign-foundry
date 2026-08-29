import { DEFAULT_DURATION_SEC } from "./variation-defaults.js";

/**
 * Sequenced copy for a motion clip — beats, not timestamps (D1).
 *
 * A timeline describes *order and proportion*: an ordered list of `{ text, weight }`
 * beats resolve, at prepare time, to `t`-windows whose boundaries are identical at
 * every duration, so the same timeline is valid for every length the duration axis
 * can draw. No second ever appears in the stored brief; the run supplies the seconds.
 *
 * `keyBeat` is a persisted 1-based *index*, not a text reference. It is deliberately
 * an index so that the editor's reducer (E5) can keep the poster's text stable across
 * reorder/remove by re-pointing the index at the same beat — the invariant being that
 * *the selected text must not change because rows moved*. Nothing here maintains it:
 * that is the reducer's job. This VO only validates it stays in range and documents
 * the contract its types must uphold.
 */

/** Readable-dwell floor, per beat, in whole seconds. Provisional — see the plan's risk table. */
export const MIN_DWELL_SEC = 1.2;
/** The largest number of beats a timeline may carry. Also provisional. */
export const MAX_BEATS = 8;
/**
 * Upper bound on a beat's weight.
 *
 * Weights are bounded to [1, MAX_WEIGHT] by the parser, this VO and the editor alike,
 * because `Number.isInteger(1e308)` is `true`: eight such beats sum to `Infinity`,
 * every share becomes `w / Infinity = 0`, and the windows collapse to a single beat.
 * MAX_WEIGHT is not merely a guard — the D3 floor already makes a ratio beyond about
 * 8:1 unusable at any legal duration, so 20 is generous.
 */
export const MAX_WEIGHT = 20;

export interface CopyBeat {
  readonly text: string;
  /** An integer in [1, MAX_WEIGHT]. */
  readonly weight: number;
}

export interface CopyTimeline {
  readonly beats: readonly CopyBeat[];
  readonly transition: "cut" | "fade";
  /** 1-based index of the beat the poster shows (D7). Must be in [1, beats.length]. */
  readonly keyBeat: number;
}

export interface ResolvedBeat {
  readonly text: string;
  /** Inclusive start of the beat's `t`-window. */
  readonly startT: number;
  /**
   * Exclusive end of the beat's `t`-window — EXCEPT the last beat, whose window is
   * closed at 1 so that `beatAt` is total (the encoder renders t = 1 on every clip's
   * final frame).
   *
   * The last beat's end is written as a literal 1 rather than the accumulated
   * `cursor / total`. With the weights this domain allows — integers in [1, MAX_WEIGHT],
   * at most MAX_BEATS of them — those are the same number exactly: the cursor ends on
   * the integer total and `total / total` is exactly 1 in IEEE-754. So this is belt and
   * braces, not a bug fix, and a mutation test confirms no behaviour depends on it
   * today. It earns its place by making the invariant true *by construction* rather
   * than by arithmetic that happens to be exact — if weights ever stop being integers,
   * the closing boundary still lands on 1 and `beatAt` stays total.
   */
  readonly endT: number;
  /**
   * Width in `t` of the crossfade into this beat from its predecessor, 0 for `cut`
   * and for the first beat. Duration-dependent by design (D9): a fade is authored in
   * seconds, so it occupies more of `t` in a short clip than a long one.
   */
  readonly fadeInT: number;
}

/** Fade width is whichever is smaller: 0.4 s, or 25 % of the shorter adjacent beat (D9). */
const FADE_WIDTH_MAX_SEC = 0.4;
const FADE_WIDTH_SHARE = 0.25;
/**
 * Float tolerance for the dwell-floor comparison. `3 * MIN_DWELL_SEC` is
 * `3.5999999999999996`, so a beat whose dwell is exactly on the floor can read a hair
 * under it; compare with a tolerance so a boundary case is not wrongly rejected.
 */
const DWELL_TOLERANCE = 1e-9;

/**
 * Beats → `t`-windows. Duration is needed only to bound the fade width (D9).
 *
 * `startT_i = Σw_<i / Σw`, which is what makes the boundaries duration-invariant —
 * the same start/end `t` pairs drive a 5 s and a 15 s clip (D2). `fadeInT` is *not*
 * invariant, and is not meant to be.
 */
export function resolveTimeline(t: CopyTimeline, durationSec: number): readonly ResolvedBeat[] {
  const weights = t.beats.map((beat) => beat.weight);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const resolved: ResolvedBeat[] = [];
  let cursor = 0;
  for (let i = 0; i < t.beats.length; i += 1) {
    const beat = t.beats[i];
    const startT = cursor / total;
    cursor += weights[i];
    const isLast = i === t.beats.length - 1;
    const endT = isLast ? 1 : cursor / total;
    resolved.push({
      text: beat.text,
      startT,
      endT,
      fadeInT: fadeInWidth(t, i, weights, total, durationSec),
    });
  }
  return resolved;
}

/** The crossfade width (in `t`) into beat `i`, 0 for `cut` and for the first beat. */
function fadeInWidth(
  t: CopyTimeline,
  i: number,
  weights: readonly number[],
  total: number,
  durationSec: number,
): number {
  // A clip of no length has no room to fade. Without this the arithmetic below is
  // `0 / 0`, and a NaN `fadeInT` propagates into `beatAt`'s comparisons, where every
  // test against it is false — so the fade silently disappears instead of failing.
  if (t.transition === "cut" || i === 0 || durationSec <= 0) return 0;
  const prevSec = (durationSec * weights[i - 1]) / total;
  const thisSec = (durationSec * weights[i]) / total;
  const fadeSec = Math.min(FADE_WIDTH_MAX_SEC, FADE_WIDTH_SHARE * Math.min(prevSec, thisSec));
  return fadeSec / durationSec;
}

/**
 * The beat pair live at `t`, with the crossfade mix in [0, 1]. Total on [0, 1].
 *
 * When `t` sits inside a beat's incoming fade, `current` is the outgoing beat (shown
 * at `1 - mix`) and `incoming` the one fading in (shown at `mix`); outside fades the
 * mix is 0 and `current` is the beat whose window holds `t`. At `t = 1` — every
 * clip's final frame — this returns the last beat with mix 0: the fade can never
 * consume the whole final beat (its width is at most 25 % of it), so `t = 1` is
 * always past the fade.
 */
export function beatAt(
  resolved: readonly ResolvedBeat[],
  t: number,
): { readonly current: ResolvedBeat; readonly incoming?: ResolvedBeat; readonly mix: number } {
  // Select the beat whose window holds `t`. The windows tile [0,1] — half-open except
  // the last, which is closed at 1 — so "the first window whose end exceeds t, or the
  // last once reached" is total on [0,1]: the last iteration always breaks, so there is
  // no fallback branch to leave uncovered.
  // An empty list has no beat to be "at". The return type promises a `current`, so
  // returning `resolved[0]` here would hand the compositor `undefined` behind a
  // non-optional type and fail somewhere further away, wearing someone else's name.
  // Callers reach this through `resolveTimeline`, which only yields an empty list for a
  // timeline `timelineProblem` rejects — so this is unreachable in the pipeline and
  // loud if that ever stops being true.
  if (resolved.length === 0) {
    throw new Error("beatAt: the resolved timeline is empty; validate with timelineProblem first.");
  }
  let selected = 0;
  for (let i = 0; i < resolved.length; i += 1) {
    if (t < resolved[i].endT || i === resolved.length - 1) {
      selected = i;
      break;
    }
  }
  if (
    selected > 0 &&
    resolved[selected].fadeInT > 0 &&
    t < resolved[selected].startT + resolved[selected].fadeInT
  ) {
    const fadeInT = resolved[selected].fadeInT;
    return {
      current: resolved[selected - 1],
      incoming: resolved[selected],
      mix: (t - resolved[selected].startT) / fadeInT,
    };
  }
  return { current: resolved[selected], mix: 0 };
}

/**
 * Authoring rule (D3), the single source of truth for what makes a timeline invalid —
 * structural violations first (the editor and the running parser both mirror this),
 * then the readability floor, per beat:
 *
 *     d × wᵢ / Σw ≥ MIN_DWELL_SEC   for every i
 *
 * where `d` is the shortest duration the axis can draw — or `DEFAULT_DURATION_SEC`
 * when `durations` is empty, since `min([])` is `Infinity` and would make the floor
 * vacuous on a brief that still runs. The floor binds the *thinnest* beat, which is
 * why an average-based rule is rejected: weights [5, 1, 1] at 5 s pass `beats ×
 * MIN_DWELL ≤ d` while each light beat gets 0.71 s. Returns the first problem found,
 * or `undefined` when the timeline is valid. `transition` is not checked here: it is a
 * `"cut" | "fade"` union, so an invalid value cannot be represented in the domain and
 * is rejected by the raw-brief parser.
 */
export function timelineProblem(t: CopyTimeline, durations: readonly number[]): string | undefined {
  if (t.beats.length === 0) {
    return "copy.timeline.beats must not be empty.";
  }
  if (t.beats.length > MAX_BEATS) {
    return `copy.timeline.beats holds more than ${MAX_BEATS} beats (max ${MAX_BEATS}).`;
  }
  for (let i = 0; i < t.beats.length; i += 1) {
    const weight = t.beats[i].weight;
    if (!Number.isInteger(weight) || weight < 1 || weight > MAX_WEIGHT) {
      return `copy.timeline.beats[${i}].weight must be an integer in [1, ${MAX_WEIGHT}].`;
    }
  }
  if (!Number.isInteger(t.keyBeat) || t.keyBeat < 1 || t.keyBeat > t.beats.length) {
    return `copy.timeline.keyBeat must be an integer in [1, ${t.beats.length}].`;
  }

  const total = t.beats.reduce((sum, beat) => sum + beat.weight, 0);
  const d = durations.length > 0 ? Math.min(...durations) : DEFAULT_DURATION_SEC;
  for (let i = 0; i < t.beats.length; i += 1) {
    const dwellSec = (d * t.beats[i].weight) / total;
    if (dwellSec < MIN_DWELL_SEC - DWELL_TOLERANCE) {
      return (
        `copy.timeline.beats[${i}] (${t.beats[i].text}) stays ${dwellSec.toFixed(2)}s below the ` +
        `${MIN_DWELL_SEC}s readability floor at the shortest duration (${d}s).`
      );
    }
  }
  return undefined;
}
