import { createHash } from "node:crypto";
import { err, ok, seedFrom, type Result } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../entities/CampaignBrief.js";
import { AspectRatio, type AspectRatioValue } from "./AspectRatio.vo.js";
import { LAYOUT_VALUES, TONE_VALUES, type LayoutKind, type ToneKind } from "./Treatment.vo.js";

/**
 * Background *axis* values from the brief parser (`procedural` | `asset-pool` | `genai`).
 * Distinct from the rendered-asset BackgroundSource (firefly/imagen/…).
 */
export const BACKGROUND_AXIS_SOURCES = ["procedural", "asset-pool", "genai"] as const;
export type BackgroundAxisSource = (typeof BACKGROUND_AXIS_SOURCES)[number];

/** Hamming axes — a candidate must differ in at least `minDistance` of these. */
export const DISTANCE_AXES = [
  "productId",
  "aspectRatio",
  "layout",
  "tone",
  "backgroundSource",
  "paletteShift",
] as const;

const UINT32_MAX = 0xffffffff;
const DEFAULT_BACKGROUND_SOURCES: readonly BackgroundAxisSource[] = ["procedural"];
const DEFAULT_PALETTE_SHIFT: readonly number[] = [0];

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
    readonly productIds: readonly string[],
    readonly ratios: readonly AspectRatioValue[],
    readonly axisProductSize: number,
    readonly policyHash: string,
  ) {}

  static fromBrief(brief: CampaignBrief): Result<VariationPolicy, Error> {
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

    const minDistanceResult = requireInteger(
      variation.minDistance ?? 1,
      "minDistance",
      0,
      DISTANCE_AXES.length,
    );
    if (!minDistanceResult.success) return minDistanceResult;
    const minDistance = minDistanceResult.value;

    const perProductResult = requireInteger(variation.coverage?.perProduct ?? 0, "coverage.perProduct", 0);
    if (!perProductResult.success) return perProductResult;
    const perRatioResult = requireInteger(variation.coverage?.perRatio ?? 0, "coverage.perRatio", 0);
    if (!perRatioResult.success) return perRatioResult;
    const coverage: VariationCoverage = {
      perProduct: perProductResult.value,
      perRatio: perRatioResult.value,
    };

    const axes = variation.axes;
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
    const ratios = AspectRatio.all().map((ratio) => ratio.value);
    const axisProductSize =
      productIds.length *
      ratios.length *
      layout.length *
      tone.length *
      backgroundSource.length *
      paletteShift.length;

    const policyHash = hashPolicy({
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
    });

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
        productIds,
        ratios,
        axisProductSize,
        policyHash,
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
    if (typeof shift !== "number" || !Number.isFinite(shift) || shift < 0 || shift > 1) {
      return err(new Error("Invalid paletteShift."));
    }
  }
  return ok(values);
}

function hashPolicy(payload: {
  axisProductSize: number;
  backgroundSource: readonly string[];
  count: number;
  coverage: VariationCoverage;
  layout: readonly string[];
  minDistance: number;
  paletteShift: readonly number[];
  productIds: readonly string[];
  ratios: readonly string[];
  seed: number;
  tone: readonly string[];
}): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
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
