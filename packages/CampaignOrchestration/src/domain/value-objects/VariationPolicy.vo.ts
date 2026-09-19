import { err, ok, seedFrom, type Result } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../entities/CampaignBrief.js";
import { AspectRatio } from "./AspectRatio.vo.js";
import type { AspectRatioValue } from "./aspect-ratios.js";
import { LAYOUT_VALUES, TONE_VALUES, type LayoutKind, type ToneKind } from "./Treatment.vo.js";
import { MOTION_KINDS, type MotionKind } from "./MotionKind.vo.js";
import { isPaletteShift } from "./palette-shift.js";
// The axis vocabulary and its defaults live in variation-defaults.ts;
// re-exported here so the VO's public surface is unchanged.
import {
  HEADLINE_POOL_REF,
  DEFAULT_BACKGROUND_SOURCES,
  DEFAULT_DURATION,
  DEFAULT_MOTION,
  DEFAULT_PALETTE_SHIFT,
  MAX_DURATION_SEC,
  MIN_DURATION_SEC,
  POLICY_INTEGERS,
  POLICY_MAX_ACTIVE_AXES,
  type AnchorKind,
  type AuthoredOccupancy,
  type BackgroundAxisSource,
  type PolicyIntegerAbsence,
  type PolicyIntegerRule,
} from "./variation-defaults.js";

export {
  BACKGROUND_AXIS_SOURCES,
  DEFAULT_BACKGROUND_SOURCES,
  DEFAULT_DURATION,
  DEFAULT_DURATION_SEC,
  DEFAULT_MOTION,
  DEFAULT_PALETTE_SHIFT,
  HEADLINE_POOL_REF,
  MAX_DURATION_SEC,
  MIN_DURATION_SEC,
  ANCHOR_VALUES,
  POLICY_INTEGERS,
  POLICY_MAX_ACTIVE_AXES,
  UINT32_MAX,
  type AnchorKind,
  type AuthoredOccupancy,
  type BackgroundAxisSource,
  type PolicyIntegerAbsence,
  type PolicyIntegerName,
  type PolicyIntegerRule,
} from "./variation-defaults.js";

/** Digest function injected into policy hashing to keep domain free of platform crypto builtins. */
export type PolicyHasher = (canonicalPayloadJson: string) => string;

/** Hamming axes — a candidate must differ in at least `minDistance` of these. */
export const DISTANCE_AXES = [
  "productId",
  "aspectRatio",
  "layout",
  "tone",
  "backgroundSource",
  "paletteShift",
  "headline",
  "motion",
  "durationSec",
  "anchor",
] as const;

/**
 * Plan-time inputs resolved by the caller (the domain never reads files or the
 * profile table, and the policy reads its axes from one place):
 * - `headlines` are the approved texts of the brief's copy pool, loaded by
 *   the caller when `axes.headline` is `pool://copy`.
 * - `motionRatios` are the canvas ratios of the requested motion-capable
 *   platforms, resolved by the caller from `output.platforms`. Absent → every
 *   ratio may carry a clip; empty → none can be packaged, so none is drawn.
 * - `ratios` is the requested subset of the ratio axis, resolved by the caller
 *   from `variation.axes.ratio`. Absent → every ratio (the behaviour before
 *   the axis was authorable); empty → the author selected none.
 */
export interface PlanInput {
  readonly headlines?: readonly string[];
  readonly motionRatios?: readonly AspectRatioValue[];
  readonly ratios?: readonly AspectRatioValue[];
}

export interface VariationCoverage {
  readonly perProduct: number;
  readonly perRatio: number;
}

/**
 * Occupancy as the brief writes it (SL-D2, option (a)): the monotonic
 * allocation cursor plus the slots that were deleted.
 *
 * **Why tombstones and not a list of live indices.** Both encodings carry the
 * same information once `nextIndex` is present, so the choice is a document
 * one, and the brief is YAML an operator reads and a human diffs:
 *
 * - The common shape is "twelve slots, one deleted". As tombstones that is
 *   `nextIndex: 12` + `tombstoned: [7]` — two lines that name the gesture.
 *   As a live list it is `[0,1,2,3,4,5,6,8,9,10,11]`, where the reader has to
 *   hunt for the gap, and which restates `count` in the overwhelmingly common
 *   no-deletes case.
 * - A delete diffs as one appended entry; an add diffs as `nextIndex + 1`
 *   alone. A live list has to change in two places for an add, and the two can
 *   disagree.
 * - `{ nextIndex: 13, tombstoned: [12] }` — live `0..11` after the newest slot
 *   was deleted — is the state a live list *cannot* express without
 *   `nextIndex` anyway, which is why `nextIndex` is required either way.
 *
 * The cost is that a mistyped key (`tombstones`, plural) would silently
 * resurrect a deleted creative, so the loader refuses unknown keys inside the
 * block rather than tolerating them.
 */
export interface VariationOccupancy {
  /** The next index to allocate. Monotonic (SL-D3): a tombstoned index is never reissued. */
  readonly nextIndex: number;
  /** The live slots, ascending — `[0, nextIndex)` minus the tombstoned ones. */
  readonly liveIndices: readonly number[];
  /** The deleted slots, ascending. Each one is below `nextIndex` and absent from `liveIndices`. */
  readonly tombstoned: readonly number[];
}

/**
 * VariationPolicy — resolved draw policy for a variation-mode brief.
 *
 * `policyHash` is sha256-hex of the canonical JSON of every field except itself
 * (object keys sorted recursively; array order preserved).
 */
export class VariationPolicy {
  private constructor(
    readonly count: number,
    readonly seed: number,
    readonly minDistance: number,
    readonly coverage: VariationCoverage,
    readonly layout: readonly LayoutKind[],
    readonly tone: readonly ToneKind[],
    readonly backgroundSource: readonly BackgroundAxisSource[],
    readonly paletteShift: readonly number[],
    /** Approved pool texts; empty when the brief has no headline axis. */
    readonly headline: readonly string[],
    /**
     * The anchor axis when the brief carries it; empty when absent. An absent
     * axis means the compositor derives the placement from `layout` — the
     * pre-axis behaviour — so it must join nothing for such a brief (D57).
     */
    readonly anchor: readonly AnchorKind[],
    readonly productIds: readonly string[],
    readonly ratios: readonly AspectRatioValue[],
    readonly axisProductSize: number,
    readonly policyHash: string,
    readonly motion: readonly MotionKind[],
    readonly duration: readonly number[],
    /** True iff `output.formats` includes "motion" and the motion axis is non-empty. */
    readonly motionEnabled: boolean,
    /** True iff `output.formats` also includes "static": the motion draw keeps a still slot. */
    readonly mixStatic: boolean,
    /** Ratios a motion slot may be drawn for (every ratio unless `output.platforms` narrows it). */
    readonly motionRatios: readonly AspectRatioValue[],
    /**
     * Which slots exist (SL-D2/SL-D3). Resolved, never optional here: a brief
     * with no `variation.occupancy` block gets the derived status quo —
     * `nextIndex = count`, no tombstones, live `0..count-1` — so every caller
     * reads one shape and the pre-SL1 brief is the `tombstoned: []` case.
     *
     * Deliberately **not** in `policyHash`: the hash pins the draw policy so a
     * selective re-roll is refused when the recipe moved underneath it, and
     * occupancy is the drawn set's state, not the recipe. Folding it in would
     * move the hash on every delete and refuse a re-roll of each SURVIVING
     * slot — the exact property this plan exists to deliver (§7's first line:
     * deleting a creative leaves the others byte-identical).
     */
    readonly occupancy: VariationOccupancy,
  ) {}

  /**
   * `hasher` is required, and deliberately a parameter rather than an optional field on
   * `PlanInput`: wiring it is a composition concern, and a missing digest function is a
   * mistake the compiler can catch. An optional one would push that to a runtime error on
   * a path that only fires in a misconfigured deployment.
   */
  static fromBrief(
    brief: CampaignBrief,
    input: PlanInput,
    hasher: PolicyHasher,
  ): Result<VariationPolicy, Error> {
    const hashFn = hasher;

    const variation = brief.variation;
    // The `count` rule's `absent: { kind: "required" }` is what refuses a brief
    // with no count; a brief with no `variation` block at all has no count
    // either, so it takes the same refusal through the same message.
    if (variation === undefined) {
      return err(new Error(requiredMessage(POLICY_INTEGERS.count)));
    }

    const countResult = resolvePolicyInteger(variation.count, POLICY_INTEGERS.count);
    if (!countResult.success) return countResult;
    const count = countResult.value;

    const occupancyResult = resolveOccupancy(variation.occupancy, count);
    if (!occupancyResult.success) return occupancyResult;
    const occupancy = occupancyResult.value;

    // `seed`'s absence is `derived`, and this is the caller the table means: the
    // domain, not the editor, is where a brief with no seed gets one.
    const seedResult = resolvePolicyInteger(variation.seed, POLICY_INTEGERS.seed, {
      derived: seedFrom(brief.id),
    });
    if (!seedResult.success) return seedResult;
    const seed = seedResult.value;

    const perProductResult = resolvePolicyInteger(
      variation.coverage?.perProduct,
      POLICY_INTEGERS.perProduct,
    );
    if (!perProductResult.success) return perProductResult;
    const perRatioResult = resolvePolicyInteger(
      variation.coverage?.perRatio,
      POLICY_INTEGERS.perRatio,
    );
    if (!perRatioResult.success) return perRatioResult;
    const coverage: VariationCoverage = {
      perProduct: perProductResult.value,
      perRatio: perRatioResult.value,
    };

    const axes = variation.axes;
    const formats = brief.output?.formats ?? ["static"];
    const wantsMotion = formats.includes("motion");
    // Absent axis + motion format → all kinds; an explicit empty axis with the
    // motion format is a contradiction the parser rejects and the domain refuses
    // too, so a brief that asks for clips can never silently render stills.
    const motion = unique(
      axes?.motion !== undefined
        ? [...(axes.motion as readonly MotionKind[])]
        : wantsMotion
          ? [...DEFAULT_MOTION]
          : [],
    );
    const motionResult = requireMotion(motion, wantsMotion);
    if (!motionResult.success) return motionResult;
    const duration = unique(
      axes?.duration !== undefined ? [...axes.duration] : [...DEFAULT_DURATION],
    );
    const durationResult = requireDuration(duration);
    if (!durationResult.success) return durationResult;
    const motionEnabled = wantsMotion && motion.length > 0;
    const mixStatic = motionEnabled && formats.includes("static");

    const headlineResult = resolveHeadline(brief, axes?.headline, input.headlines);
    if (!headlineResult.success) return headlineResult;
    const headline = headlineResult.value;
    const anchor = unique(
      axes?.anchor !== undefined ? [...(axes.anchor as readonly AnchorKind[])] : [],
    );

    // A candidate can differ in at most the axes this brief activates: every
    // DISTANCE_AXES entry except the optional ones that are off. An optional axis
    // counts only while it has at least one drawable option: `headline` when the
    // pool resolved to at least one text, `motion` when the axis is enabled —
    // and `durationSec` is drawn only on motion slots, so it follows `motion`.
    // `anchor` counts only when the brief carries the axis: without it the
    // compositor derives the placement from `layout`, so it cannot differ.
    const activeAxes = DISTANCE_AXES.filter((axis) => {
      if (axis === "headline") return headline.length > 0;
      if (axis === "anchor") return anchor.length > 0;
      if (axis === "motion" || axis === "durationSec") return motionEnabled;
      return true;
    }).length;
    // SL-D6 lives in the table now (`POLICY_INTEGERS.minDistance`): the lower
    // bound is 1, not 0, and an absent field means 1 — so the bound refuses only
    // an *explicit* 0. The upper bound is this brief's own active-axis count,
    // which is the one part of the rule no table can hold, so the rule says
    // `POLICY_MAX_ACTIVE_AXES` and the number is supplied here.
    const minDistanceResult = resolvePolicyInteger(
      variation.minDistance,
      POLICY_INTEGERS.minDistance,
      { activeAxes },
    );
    if (!minDistanceResult.success) return minDistanceResult;
    const minDistance = minDistanceResult.value;

    const layout = unique(
      axes?.layout !== undefined ? [...(axes.layout as readonly LayoutKind[])] : [...LAYOUT_VALUES],
    );
    const tone = unique(
      axes?.tone !== undefined ? [...(axes.tone as readonly ToneKind[])] : [...TONE_VALUES],
    );
    const backgroundSource = unique(
      axes?.background?.source !== undefined
        ? [...(axes.background.source as readonly BackgroundAxisSource[])]
        : [...DEFAULT_BACKGROUND_SOURCES],
    );
    const paletteShift = unique(
      axes?.paletteShift !== undefined ? [...axes.paletteShift] : [...DEFAULT_PALETTE_SHIFT],
    );
    const paletteShiftResult = requirePaletteShift(paletteShift);
    if (!paletteShiftResult.success) return paletteShiftResult;
    const productIds = unique(brief.products.map((product) => product.id));
    const allRatios = AspectRatio.all().map((ratio) => ratio.value);
    const motionRatios = unique(input.motionRatios ?? allRatios);
    const ratiosResult = requireRatios(input.ratios, allRatios);
    if (!ratiosResult.success) return ratiosResult;
    // The author's selection narrows first, then the motion filter: a motion-only
    // brief (`formats: [motion]`, no still slot) can only be drawn at ratios a
    // requested motion platform packages: a slot at any other ratio would
    // "stay a still" — a still the brief never asked for. A mixed plan keeps every
    // requested ratio, since its non-motion ratios are legitimately the stills
    // the static format requested.
    const requested = unique(ratiosResult.value ?? allRatios);
    const ratios =
      motionEnabled && !mixStatic
        ? requested.filter((ratio) => motionRatios.includes(ratio))
        : requested;
    if (ratios.length === 0) {
      // Absent input keeps today's message byte-for-byte: the only way an
      // unrestricted ratio axis empties is motionRatios being empty.
      if (input.ratios === undefined) {
        return err(
          new Error(
            `output.formats requests only "motion" but none of output.platforms package it at any aspect ratio.`,
          ),
        );
      }
      if (requested.length === 0) {
        return err(
          new Error(
            `Invalid variation.axes.ratio: select at least one aspect ratio (expected one of ${allRatios.join(", ")}).`,
          ),
        );
      }
      return err(
        new Error(
          `output.formats requests only "motion", which the requested platforms package at [${motionRatios.join(", ")}], but variation.axes.ratio selects [${requested.join(", ")}] — select one of those ratios or add the static format.`,
        ),
      );
    }
    // Slots one base combination yields, summed over the ratios — NOT a single
    // motion factor multiplied across every ratio. `enumerateAxes` draws motion
    // only where `motionRatios` says the requested platforms package it, so a
    // ratio outside that set carries exactly one still and nothing else: the
    // clip it would otherwise need can be packaged nowhere. A mixed plan adds
    // that one still per base combination at its motion ratios too — the still
    // carries no duration, so it is not multiplied by |duration|.
    //
    // Multiplying across every ratio over-counted a mixed plan (SG-D7 measured
    // 48 against the enumerator's 32 on a three-ratio brief whose platforms
    // package motion at one). `count` is clamped to this number, so the
    // over-count made the count slider's own maximum unplannable.
    //
    // Motion-only and static-only are unmoved: a motion-only brief's `ratios`
    // are already narrowed to `motionRatios` above, so every term is the motion
    // factor, and a static brief's every term is 1.
    const ratioSlots = ratios.reduce(
      (total, ratio) =>
        total +
        (motionEnabled && motionRatios.includes(ratio)
          ? motion.length * duration.length + (mixStatic ? 1 : 0)
          : 1),
      0,
    );
    // The anchor axis multiplies only when the brief carries it (D57): absent
    // means derived from `layout`, which adds no new combination.
    const axisProductSize =
      productIds.length *
      ratioSlots *
      layout.length *
      tone.length *
      backgroundSource.length *
      paletteShift.length *
      Math.max(1, headline.length) *
      Math.max(1, anchor.length);

    const policyHash = hashPolicy(
      {
        axisProductSize,
        backgroundSource,
        count,
        coverage,
        layout,
        minDistance,
        paletteShift,
        productIds,
        ratios,
        seed,
        tone,
        // Static briefs hash exactly as before the motion axes existed (golden-stable).
        ...(motionEnabled ? { duration, mixStatic, motion, motionRatios } : {}),
        // Only briefs with the headline axis carry it in the hash, so every
        // pre-existing policyHash (and golden) is unchanged.
        ...(headline.length > 0 ? { headline } : {}),
        // The anchor axis follows the same conditional-spread pattern (D57):
        // a brief without it keeps the exact pre-axis policyHash.
        ...(anchor.length > 0 ? { anchor } : {}),
      },
      hashFn,
    );

    return ok(
      new VariationPolicy(
        count,
        seed,
        minDistance,
        coverage,
        layout,
        tone,
        backgroundSource,
        paletteShift,
        headline,
        anchor,
        productIds,
        ratios,
        axisProductSize,
        policyHash,
        motion,
        duration,
        motionEnabled,
        mixStatic,
        motionRatios,
        occupancy,
      ),
    );
  }
}

/**
 * Resolve `variation.occupancy` into the shape every caller reads.
 *
 * Absent → the derived status quo (SL1's back-compat property): `nextIndex`
 * is `count`, nothing is tombstoned, and the live slots are `0..count-1`.
 * This is computed here and **never written back onto the brief** — a stored
 * brief that carried no occupancy must still carry none after a save, or
 * every existing campaign's YAML churns on first write.
 *
 * The checks mirror the loader's (`apps/api/server/lib/load-brief.ts`) rather
 * than trusting it: the domain is reachable from callers that never parsed a
 * file. A tombstone at or above `nextIndex` names a slot that was never
 * allocated, which is the tombstone encoding's form of "the cursor sits below
 * a slot that exists" — with a live list that fault reads as `nextIndex`
 * below the highest live index.
 */
function resolveOccupancy(
  occupancy: AuthoredOccupancy | undefined,
  count: number,
): Result<VariationOccupancy, Error> {
  if (occupancy === undefined) {
    return ok({
      nextIndex: count,
      liveIndices: Array.from({ length: count }, (_unused, index) => index),
      tombstoned: [],
    });
  }
  const nextIndexResult = requireInteger(occupancy.nextIndex, "occupancy.nextIndex", 0);
  if (!nextIndexResult.success) return nextIndexResult;
  const nextIndex = nextIndexResult.value;
  const tombstoned: number[] = [];
  for (const slot of occupancy.tombstoned ?? []) {
    if (!Number.isInteger(slot) || slot < 0) {
      return err(new Error(`Invalid occupancy.tombstoned: ${JSON.stringify(slot)}.`));
    }
    if (slot >= nextIndex) {
      return err(
        new Error(
          `Invalid occupancy.tombstoned: slot ${slot} was never allocated (occupancy.nextIndex is ${nextIndex}).`,
        ),
      );
    }
    if (tombstoned.includes(slot)) {
      return err(new Error(`Invalid occupancy.tombstoned: slot ${slot} is listed twice.`));
    }
    tombstoned.push(slot);
  }
  tombstoned.sort((a, b) => a - b);
  const liveIndices: number[] = [];
  for (let index = 0; index < nextIndex; index += 1) {
    if (!tombstoned.includes(index)) liveIndices.push(index);
  }
  return ok({ nextIndex, liveIndices, tombstoned });
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** The refusal an `absent: { kind: "required" }` rule produces, and the only place it is spelled. */
function requiredMessage(rule: PolicyIntegerRule): string {
  return `Variation policy requires ${JSON.stringify(rule.field)}.`;
}

/**
 * **The single site that resolves a policy integer** (M3). Absence and bounds
 * both come from `POLICY_INTEGERS`, so the five fields can no longer disagree
 * by accident — the disagreements that remain are the ones the table declares,
 * and changing one means editing the row rather than one of five `??`s.
 *
 * `derived` is the value an `absent: { kind: "derived" }` rule means (only the
 * caller can compute it — `seed` is `seedFrom(brief.id)`); `activeAxes` is the
 * number a `POLICY_MAX_ACTIVE_AXES` bound stands for. A `derived` rule whose
 * caller supplies nothing has no value to resolve to, so it takes the same
 * refusal a required key does rather than silently becoming a bound.
 */
function resolvePolicyInteger(
  authored: number | undefined,
  rule: PolicyIntegerRule,
  supplied: { readonly derived?: number; readonly activeAxes?: number } = {},
): Result<number, Error> {
  const absent: PolicyIntegerAbsence = rule.absent;
  const value = authored ?? (absent.kind === "default" ? absent.value : supplied.derived);
  if (value === undefined) return err(new Error(requiredMessage(rule)));
  const max = rule.max === POLICY_MAX_ACTIVE_AXES ? supplied.activeAxes : rule.max;
  return requireInteger(value, rule.field, rule.min, max);
}

function requireInteger(
  value: number,
  field: string,
  min: number,
  max?: number,
): Result<number, Error> {
  if (!Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    return err(new Error(`Invalid ${field}.`));
  }
  return ok(value);
}

function requirePaletteShift(values: readonly number[]): Result<readonly number[], Error> {
  for (const shift of values) {
    if (!isPaletteShift(shift)) {
      return err(
        new Error(
          `Invalid paletteShift: must contain turns in [0, 1) — 1 is a whole circle and means the same as 0; got ${JSON.stringify(shift)}.`,
        ),
      );
    }
  }
  return ok(values);
}

function requireMotion(
  values: readonly MotionKind[],
  wantsMotion: boolean,
): Result<readonly MotionKind[], Error> {
  if (wantsMotion && values.length === 0) {
    return err(
      new Error(
        'Invalid motion: select at least one motion kind when output.formats includes "motion".',
      ),
    );
  }
  for (const kind of values) {
    if (!(MOTION_KINDS as readonly string[]).includes(kind)) {
      return err(new Error("Invalid motion."));
    }
  }
  return ok(values);
}

/** The requested ratio subset must name supported ratios — the parser guarantees it, this is the domain's own check. */
function requireRatios(
  values: readonly AspectRatioValue[] | undefined,
  allRatios: readonly AspectRatioValue[],
): Result<readonly AspectRatioValue[] | undefined, Error> {
  if (values === undefined) return ok(undefined);
  for (const value of values) {
    if (!(allRatios as readonly string[]).includes(value)) {
      return err(
        new Error(
          `Invalid variation.axes.ratio: ${JSON.stringify(value)} is not a supported aspect ratio (expected one of ${allRatios.join(", ")}).`,
        ),
      );
    }
  }
  return ok(values);
}

function requireDuration(values: readonly number[]): Result<readonly number[], Error> {
  for (const seconds of values) {
    if (!Number.isInteger(seconds) || seconds < MIN_DURATION_SEC || seconds > MAX_DURATION_SEC) {
      return err(new Error("Invalid duration."));
    }
  }
  return ok(values);
}

/**
 * Canonical headline list: trimmed, blanks dropped, sorted by UTF-16 code unit
 * (`Array.prototype.sort` with no comparator — locale-independent, so every
 * machine agrees), then de-duplicated by normalised text (whitespace collapsed,
 * lower-cased), keeping the first survivor in sorted order. The pool file's
 * entry order therefore never reaches `policyHash` or the draw sequence.
 */
export function canonicalHeadlines(headlines: readonly string[]): readonly string[] {
  const sorted = headlines
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .sort();
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const text of sorted) {
    const key = text.replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    texts.push(text);
  }
  return texts;
}

/**
 * Resolve the headline axis: absent → no axis (empty). `pool://copy` → the
 * caller-supplied approved texts (canonicalised, see `canonicalHeadlines`),
 * which must be non-empty — a missing or fully-rejected pool fails loud,
 * naming the pool file.
 */
function resolveHeadline(
  brief: CampaignBrief,
  ref: string | undefined,
  headlines: readonly string[] | undefined,
): Result<readonly string[], Error> {
  if (ref === undefined) return ok([]);
  if (ref !== HEADLINE_POOL_REF) {
    return err(
      new Error(
        `Unsupported headline axis ${JSON.stringify(ref)} (expected "${HEADLINE_POOL_REF}").`,
      ),
    );
  }
  const texts = canonicalHeadlines(headlines ?? []);
  if (texts.length === 0) {
    return err(
      new Error(
        `Headline axis "${HEADLINE_POOL_REF}" needs at least one approved entry in copy pool briefs/${brief.id}/pools.json.`,
      ),
    );
  }
  return ok(texts);
}

function hashPolicy(
  payload: {
    axisProductSize: number;
    anchor?: readonly string[];
    backgroundSource: readonly string[];
    count: number;
    coverage: VariationCoverage;
    headline?: readonly string[];
    layout: readonly string[];
    minDistance: number;
    paletteShift: readonly number[];
    productIds: readonly string[];
    ratios: readonly string[];
    seed: number;
    tone: readonly string[];
    duration?: readonly number[];
    mixStatic?: boolean;
    motion?: readonly string[];
    motionRatios?: readonly string[];
  },
  hasher: PolicyHasher,
): string {
  return hasher(canonicalJson(payload));
}

/**
 * Hash of the brief's copy surface — `campaignMessage`, `localizedMessage`, and
 * `copy.timeline` in full: each beat's `text`, `weight`, and optional
 * `background`, plus the timeline's own `transition` and `keyBeat` (beat order
 * and count are covered for free — array order is preserved by
 * `canonicalJson`) — independent of `hashPolicy` (§35,
 * `docs/planning/2026-09-10_the-unowned-gaps.md`).
 *
 * Every one of those fields changes what gets rendered: `weight` is a beat's
 * share of the clip's duration, `transition` picks the cut/fade between
 * beats, and `keyBeat` decides which frame becomes the poster (D7,
 * `CopyTimeline.vo.ts`) — so all three belong beside `text`/`background` in
 * this hash for the same reason those two do.
 *
 * A selective re-roll pins BOTH hashes: `hashPolicy` alone lets a re-roll of
 * one cell pass while the brief's message or any part of its timeline moved
 * underneath it, silently merging the new copy into a report whose other
 * cells were rendered under the old copy. This is deliberately a SECOND,
 * disjoint hash rather than a widening of `hashPolicy`'s own payload —
 * `hashPolicy` is golden-stable (see the comments in `fromBrief` above), and
 * no axis ever reaches this hash, no copy field ever reaches `hashPolicy`.
 */
export function hashCopy(brief: CampaignBrief, hasher: PolicyHasher): string {
  const timeline = brief.copy?.timeline;
  return hasher(
    canonicalJson({
      campaignMessage: brief.campaignMessage,
      ...(brief.localizedMessage !== undefined ? { localizedMessage: brief.localizedMessage } : {}),
      ...(timeline !== undefined
        ? {
            timeline: {
              transition: timeline.transition,
              keyBeat: timeline.keyBeat,
              beats: timeline.beats.map((beat) => ({
                text: beat.text,
                weight: beat.weight,
                ...(beat.background !== undefined ? { background: beat.background } : {}),
              })),
            },
          }
        : {}),
    }),
  );
}

/** JSON with object keys sorted recursively; array order is preserved. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Object) {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      output[key] = sortKeys(input[key]);
    }
    return output;
  }
  return value;
}
