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
  type BackgroundAxisSource,
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
  type BackgroundAxisSource,
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
] as const;

const UINT32_MAX = 0xffffffff;

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
    if (variation === undefined || variation.count === undefined) {
      return err(new Error('Variation policy requires "count".'));
    }

    const countResult = requireInteger(variation.count, "count", 1);
    if (!countResult.success) return countResult;
    const count = countResult.value;

    const seedResult = requireInteger(variation.seed ?? seedFrom(brief.id), "seed", 0, UINT32_MAX);
    if (!seedResult.success) return seedResult;
    const seed = seedResult.value;

    const perProductResult = requireInteger(variation.coverage?.perProduct ?? 0, "coverage.perProduct", 0);
    if (!perProductResult.success) return perProductResult;
    const perRatioResult = requireInteger(variation.coverage?.perRatio ?? 0, "coverage.perRatio", 0);
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
    const duration = unique(axes?.duration !== undefined ? [...axes.duration] : [...DEFAULT_DURATION]);
    const durationResult = requireDuration(duration);
    if (!durationResult.success) return durationResult;
    const motionEnabled = wantsMotion && motion.length > 0;
    const mixStatic = motionEnabled && formats.includes("static");

    const headlineResult = resolveHeadline(brief, axes?.headline, input.headlines);
    if (!headlineResult.success) return headlineResult;
    const headline = headlineResult.value;

    // A candidate can differ in at most the axes this brief activates: every
    // DISTANCE_AXES entry except the optional ones that are off. An optional axis
    // counts only while it has at least one drawable option: `headline` when the
    // pool resolved to at least one text, `motion` when the axis is enabled —
    // and `durationSec` is drawn only on motion slots, so it follows `motion`.
    const activeAxes = DISTANCE_AXES.filter((axis) => {
      if (axis === "headline") return headline.length > 0;
      if (axis === "motion" || axis === "durationSec") return motionEnabled;
      return true;
    }).length;
    const minDistanceResult = requireInteger(variation.minDistance ?? 1, "minDistance", 0, activeAxes);
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
    const ratios = motionEnabled && !mixStatic ? requested.filter((ratio) => motionRatios.includes(ratio)) : requested;
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
    // A mixed plan adds exactly one still slot per base combination — the still
    // carries no duration, so it is not multiplied by |duration|.
    const axisProductSize =
      productIds.length *
      ratios.length *
      layout.length *
      tone.length *
      backgroundSource.length *
      paletteShift.length *
      Math.max(1, headline.length) *
      (motionEnabled ? motion.length * duration.length + (mixStatic ? 1 : 0) : 1);

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
        productIds,
        ratios,
        axisProductSize,
        policyHash,
        motion,
        duration,
        motionEnabled,
        mixStatic,
        motionRatios,
      ),
    );
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function requireInteger(value: number, field: string, min: number, max?: number): Result<number, Error> {
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

function requireMotion(values: readonly MotionKind[], wantsMotion: boolean): Result<readonly MotionKind[], Error> {
  if (wantsMotion && values.length === 0) {
    return err(new Error('Invalid motion: select at least one motion kind when output.formats includes "motion".'));
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
    return err(new Error(`Unsupported headline axis ${JSON.stringify(ref)} (expected "${HEADLINE_POOL_REF}").`));
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
