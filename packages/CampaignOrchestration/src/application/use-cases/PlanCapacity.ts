import { SeededRandom, seedFrom } from "@campaignfoundry/shared";
import { DISTANCE_AXES, type VariationPolicy } from "../../domain/value-objects/VariationPolicy.vo.js";
import type { AnchorKind } from "../../domain/value-objects/variation-defaults.js";
import type { Variant } from "../../domain/entities/Variant.js";

/** Spaces up to this size are searched exhaustively when the random draw falls short. */
export const EXHAUSTIVE_MAX_SPACE = 4096;
/** Spaces up to this size get an exact capacity (a maximum set at minDistance); larger ones a bound. */
export const EXACT_CAPACITY_MAX_SPACE = 128;
/** Restarts for the seeded greedy over the enumerated space — cheap, and reaches capacity on tight spaces. */
export const EXHAUSTIVE_RESTARTS = 16;
/** Branch-and-bound budget for the exact capacity; past it the line bound is reported instead. */
export const EXACT_CAPACITY_STEP_LIMIT = 200_000;

export type Axes = Omit<Variant, "index" | "seed">;

export interface AxisNeed {
  readonly productId?: string;
  readonly aspectRatio?: string;
}

/** Every combination the draw could produce, in a fixed order, so it can be searched or counted. */
export function enumerateAxes(policy: VariationPolicy): Axes[] {
  const out: Axes[] = [];
  const headlines: ReadonlyArray<string | undefined> = policy.headline.length > 0 ? policy.headline : [undefined];
  const anchors: ReadonlyArray<AnchorKind | undefined> = policy.anchor.length > 0 ? policy.anchor : [undefined];
  for (const productId of policy.productIds) {
    for (const aspectRatio of policy.ratios) {
      const canMotion = policy.motionEnabled && policy.motionRatios.includes(aspectRatio);
      for (const layout of policy.layout) {
        for (const tone of policy.tone) {
          for (const backgroundSource of policy.backgroundSource) {
            for (const paletteShift of policy.paletteShift) {
              for (const headline of headlines) {
                for (const anchor of anchors) {
                  const base: Axes = {
                    productId,
                    aspectRatio,
                    layout,
                    tone,
                    backgroundSource,
                    paletteShift,
                    ...(headline !== undefined ? { headline } : {}),
                    ...(anchor !== undefined ? { anchor } : {}),
                  };
                  // A still slot: always at a non-motion ratio, and once per base in a mixed plan.
                  if (!canMotion || policy.mixStatic) out.push(base);
                  if (!canMotion) continue;
                  for (const motion of policy.motion) {
                    for (const durationSec of policy.duration) out.push({ ...base, motion, durationSec });
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

export function conflicts(a: Axes, b: Axes, minDistance: number): boolean {
  let distance = 0;
  for (const axis of DISTANCE_AXES) {
    if ((a as Variant)[axis] !== (b as Variant)[axis]) distance += 1;
  }
  return distance < minDistance;
}

/** No two points differing in a single axis can both be chosen, so at most N / (largest axis). */
export function lineBound(space: readonly Axes[], policy: VariationPolicy): number {
  const largestAxis = Math.max(
    policy.productIds.length,
    policy.ratios.length,
    policy.layout.length,
    policy.tone.length,
    policy.backgroundSource.length,
    policy.paletteShift.length,
    Math.max(1, policy.headline.length),
    Math.max(1, policy.anchor.length),
    policy.motionEnabled ? policy.motion.length * policy.duration.length + (policy.mixStatic ? 1 : 0) : 1,
  );
  return Math.floor(space.length / largestAxis);
}

/**
 * Size of a maximum independent set, by branch and bound over bitsets. Returns
 * undefined when the step budget runs out, so the caller can fall back to a bound.
 */
export function maximumIndependentSet(adjacency: readonly bigint[], stepLimit: number): number | undefined {
  const popcount = (bits: bigint): number => {
    let count = 0;
    for (let x = bits; x > 0n; x &= x - 1n) count += 1;
    return count;
  };
  let best = 0;
  let steps = 0;
  let exhausted = false;
  const search = (candidates: bigint, size: number): void => {
    if (exhausted) return;
    steps += 1;
    if (steps > stepLimit) {
      exhausted = true;
      return;
    }
    if (size + popcount(candidates) <= best) return;
    if (candidates === 0n) {
      best = size;
      return;
    }
    const lowest = candidates & -candidates;
    const index = lowest.toString(2).length - 1;
    search(candidates & ~adjacency[index] & ~lowest, size + 1);
    search(candidates & ~lowest, size);
  };
  search((1n << BigInt(adjacency.length)) - 1n, 0);
  return exhausted ? undefined : best;
}

/**
 * The most variants this space can hold pairwise at least `minDistance` apart:
 * exact for small spaces, otherwise the line bound (a true upper bound either way).
 */
export function capacityAt(
  space: readonly Axes[],
  policy: VariationPolicy,
  stepLimit: number = EXACT_CAPACITY_STEP_LIMIT,
): { max: number; exact: boolean } {
  if (policy.minDistance <= 1) return { max: space.length, exact: true };
  const bound = lineBound(space, policy);
  if (space.length > EXACT_CAPACITY_MAX_SPACE) return { max: bound, exact: false };
  const adjacency = space.map((a, i) => {
    let bits = 0n;
    space.forEach((b, j) => {
      if (i !== j && conflicts(a, b, policy.minDistance)) bits |= 1n << BigInt(j);
    });
    return bits;
  });
  const exact = maximumIndependentSet(adjacency, stepLimit);
  return exact === undefined ? { max: bound, exact: false } : { max: exact, exact: true };
}

/** A candidate satisfies a coverage need when every fixed axis of the need matches. */
export function matchesNeed(candidate: Axes, need: AxisNeed): boolean {
  if (need.productId !== undefined && need.productId !== candidate.productId) return false;
  if (need.aspectRatio !== undefined && need.aspectRatio !== candidate.aspectRatio) return false;
  return true;
}

/**
 * Seeded greedy over the whole enumerated space with a few restarts: reaches the
 * capacity of a tight space where 3 × count random draws could not. Coverage needs
 * rank candidates first, as in the random draw. Deterministic for a brief and seed.
 */
export function exhaustiveAccept(
  space: readonly Axes[],
  policy: VariationPolicy,
  briefId: string,
  deficient: (accepted: readonly Variant[], policy: VariationPolicy) => readonly AxisNeed[],
): Variant[] {
  let best: Axes[] = [];
  for (let restart = 0; restart < EXHAUSTIVE_RESTARTS && best.length < policy.count; restart += 1) {
    const rng = new SeededRandom(seedFrom(briefId, String(policy.seed), "exhaustive", String(restart)));
    const order = [...space];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = rng.nextInt(i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    const chosen: Axes[] = [];
    const fits = (candidate: Axes): boolean =>
      chosen.every((existing) => !conflicts(candidate, existing, policy.minDistance));
    for (;;) {
      if (chosen.length >= policy.count) break;
      const needs = deficient(chosen as Variant[], policy);
      const ranked =
        needs.length === 0
          ? order
          : [
              ...order.filter((candidate) => needs.some((need) => matchesNeed(candidate, need))),
              ...order.filter((candidate) => !needs.some((need) => matchesNeed(candidate, need))),
            ];
      const pick = ranked.find(fits);
      if (pick === undefined) break;
      chosen.push(pick);
    }
    if (chosen.length > best.length) best = chosen;
  }
  return best.map((axes, index) => ({ index, seed: seedFrom(briefId, String(index), "0"), ...axes }));
}

export function shortfallMessage(policy: VariationPolicy, space: readonly Axes[], accepted: number): string {
  const { max, exact } = capacityAt(space, policy);
  const singleRatio = policy.motionEnabled && !policy.mixStatic && policy.ratios.length === 1;
  const why = singleRatio ? ` — every motion platform is ${policy.ratios[0]}, so the aspect ratio cannot vary` : "";
  const remedies = [`lower count to ${max}`];
  if (policy.minDistance > 1) remedies.push(`lower minDistance (at 1 the maximum is ${space.length})`);
  remedies.push("add axis values (another palette shift, layout, tone, motion kind or duration)");
  return (
    `Variation plan shortfall: accepted ${accepted} of count ${policy.count}. ` +
    `At minDistance ${policy.minDistance} this brief can yield ${exact ? "at most" : "no more than"} ${max} ` +
    `distinct variants (${space.length} combinations${why}). To fix: ${remedies.join(", ")}.`
  );
}
