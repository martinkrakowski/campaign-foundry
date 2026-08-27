import { err, ok, SeededRandom, seedFrom, type Result } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../domain/entities/CampaignBrief.js";
import type { Variant } from "../../domain/entities/Variant.js";
import type { AspectRatioValue } from "../../domain/value-objects/aspect-ratios.js";
import type { MotionKind } from "../../domain/value-objects/MotionKind.vo.js";
import type { VariationPlan } from "../../domain/value-objects/VariationPlan.vo.js";
import { DISTANCE_AXES, VariationPolicy, type PlanInput } from "../../domain/value-objects/VariationPolicy.vo.js";

/** Re-roll bound: 64 draws from `seedFrom(briefId, index, attempt)`. */
import { EXHAUSTIVE_MAX_SPACE, enumerateAxes, exhaustiveAccept, shortfallMessage } from "./PlanCapacity.js";

const REPLAN_MAX_DRAWS = 64;

/** Encode frame rate; the estimate's `frames` and the generator's `fps` agree on it. */
export const MOTION_FPS = 30;

interface AxisDraw {
  readonly productId?: string;
  readonly aspectRatio?: AspectRatioValue;
}

/**
 * PlanVariationsUseCase — pure, synchronous, seeded planner.
 *
 * `plan` round-robins deficient coverage axes, then fills to `count`, greedy-accepting
 * at Hamming `minDistance`, with a hard cap of `count × 3` candidates. Coverage is
 * a property of the accepted set. `replan` replaces one slot without breaking
 * distance or coverage. `input` carries what the brief cannot: `headlines` (the
 * approved copy pool) and `motionRatios` (the ratios the requested motion
 * platforms package) — both resolved into the policy at plan time; the stored
 * policy carries them for `replan`.
 */
export class PlanVariationsUseCase {
  plan(brief: CampaignBrief, input: PlanInput = {}): Result<VariationPlan, Error> {
    const policyResult = VariationPolicy.fromBrief(brief, input);
    if (!policyResult.success) return policyResult;
    const policy = policyResult.value;

    if (policy.axisProductSize < policy.count) {
      return err(
        new Error(
          `Variation count ${policy.count} exceeds axisProductSize ${policy.axisProductSize}.`,
        ),
      );
    }

    const productFloor = policy.coverage.perProduct * policy.productIds.length;
    if (productFloor > policy.count) {
      return err(
        new Error(
          `Coverage perProduct ${policy.coverage.perProduct} × ${policy.productIds.length} products exceeds count ${policy.count}.`,
        ),
      );
    }
    const ratioFloor = policy.coverage.perRatio * policy.ratios.length;
    if (ratioFloor > policy.count) {
      return err(
        new Error(
          `Coverage perRatio ${policy.coverage.perRatio} × ${policy.ratios.length} ratios exceeds count ${policy.count}.`,
        ),
      );
    }

    const budget = policy.count * 3;
    const rng = new SeededRandom(seedFrom(brief.id, String(policy.seed)));
    let accepted: Variant[] = [];
    let drawn = 0;
    let turn = 0;

    const remaining = (): boolean => accepted.length < policy.count && drawn < budget;

    const addCandidate = (fixed: AxisDraw): void => {
      drawn += 1;
      const axes = drawAxes(rng, policy, fixed);
      const index = accepted.length;
      const variant: Variant = {
        index,
        seed: seedFrom(brief.id, String(index), "0"),
        ...axes,
      };
      if (meetsMinDistance(variant, accepted, policy.minDistance)) {
        accepted.push(variant);
      }
    };

    while (remaining()) {
      const needs = deficient(accepted, policy);
      if (needs.length > 0) {
        addCandidate(needs[turn % needs.length]);
        turn += 1;
      } else {
        addCandidate({});
      }
    }

    if (accepted.length < policy.count) {
      // The random draw (kept first so every plan it can satisfy stays golden) has a
      // budget of 3 × count, which is hopeless in a tight space — a motion-only brief
      // sits at one aspect ratio, since every motion platform is 9:16. Search the
      // whole space instead, seeded, before deciding the brief really cannot fit.
      const space = enumerateAxes(policy);
      const exhaustive =
        space.length <= EXHAUSTIVE_MAX_SPACE ? exhaustiveAccept(space, policy, brief.id, deficient) : accepted;
      if (exhaustive.length < policy.count) {
        return err(new Error(shortfallMessage(policy, space, Math.max(accepted.length, exhaustive.length))));
      }
      accepted = exhaustive; // the coverage check below applies to either search
    }

    const unmet = firstUnmetCoverage(accepted, policy);
    if (unmet !== undefined) {
      return err(new Error(`Variation plan coverage unmet: ${unmet}.`));
    }

    return ok(toPlan(brief.id, policy, accepted));
  }

  replan(plan: VariationPlan, index: number, attempt: number): Result<VariationPlan, Error> {
    if (!Number.isInteger(index) || index < 0 || index >= plan.variants.length) {
      return err(new Error(`Invalid variant index ${index}.`));
    }
    if (!Number.isInteger(attempt) || attempt < 1) {
      return err(new Error(`replan attempt must be an integer >= 1 (received ${attempt}).`));
    }

    const occupant = plan.variants[index];
    const rng = new SeededRandom(seedFrom(plan.briefId, String(index), String(attempt)));
    const others = plan.variants.filter((_, slot) => slot !== index);
    const seed = seedFrom(plan.briefId, String(index), String(attempt));

    for (let draw = 0; draw < REPLAN_MAX_DRAWS; draw++) {
      const axes = drawAxes(rng, plan.policy, {
        productId: occupant.productId,
        aspectRatio: occupant.aspectRatio,
      });
      const variant: Variant = { index, seed, ...axes };
      if (!meetsMinDistance(variant, others, plan.policy.minDistance)) continue;
      const variants = plan.variants.map((current, slot) => (slot === index ? variant : current));
      if (firstUnmetCoverage(variants, plan.policy) !== undefined) continue;
      return ok({
        ...plan,
        variants,
        estimate: { ...plan.estimate, genaiCalls: genaiCalls(variants), ...framesEstimate(variants, plan.policy) },
      });
    }

    return err(
      new Error(
        `replan exhausted ${REPLAN_MAX_DRAWS} draws for index ${index} without satisfying minDistance ${plan.policy.minDistance} and coverage.`,
      ),
    );
  }
}

function drawAxes(
  rng: SeededRandom,
  policy: VariationPolicy,
  fixed: AxisDraw,
): Omit<Variant, "index" | "seed"> {
  // Draw order is the golden sequence: product, ratio, then the treatment axes.
  const productId = fixed.productId ?? rng.pick(policy.productIds);
  const aspectRatio = fixed.aspectRatio ?? rng.pick(policy.ratios);
  return {
    productId,
    aspectRatio,
    layout: rng.pick(policy.layout),
    tone: rng.pick(policy.tone),
    backgroundSource: rng.pick(policy.backgroundSource),
    paletteShift: rng.pick(policy.paletteShift),
    // Optional axes draw last, each only when on, so briefs without them keep their goldens.
    ...drawHeadline(rng, policy),
    ...drawMotion(rng, policy, aspectRatio),
  };
}

/** Draw a pooled headline, so briefs without the axis leave the rng sequence untouched. */
function drawHeadline(rng: SeededRandom, policy: VariationPolicy): Pick<Variant, "headline"> {
  return policy.headline.length === 0 ? {} : { headline: rng.pick(policy.headline) };
}

/**
 * Motion axes. Static briefs consume no draws (goldens unchanged). With both
 * formats requested the draw keeps one still slot, so a mixed brief yields PNGs
 * and mp4s; `duration` is drawn only for a motion slot. A ratio no requested
 * motion platform packages stays a still (no draws consumed).
 */
function drawMotion(
  rng: SeededRandom,
  policy: VariationPolicy,
  aspectRatio: AspectRatioValue,
): Pick<Variant, "motion" | "durationSec"> {
  if (!policy.motionEnabled || !policy.motionRatios.includes(aspectRatio)) return {};
  const slots: ReadonlyArray<MotionKind | undefined> = policy.mixStatic
    ? [undefined, ...policy.motion]
    : policy.motion;
  const motion = rng.pick(slots);
  if (motion === undefined) return {};
  return { motion, durationSec: rng.pick(policy.duration) };
}

function hamming(a: Variant, b: Variant): number {
  let distance = 0;
  for (const axis of DISTANCE_AXES) {
    if (a[axis] !== b[axis]) distance += 1;
  }
  return distance;
}

function meetsMinDistance(
  candidate: Variant,
  accepted: readonly Variant[],
  minDistance: number,
): boolean {
  return accepted.every((variant) => hamming(candidate, variant) >= minDistance);
}

function countBy<T>(items: readonly T[], pred: (item: T) => boolean): number {
  let n = 0;
  for (const item of items) {
    if (pred(item)) n += 1;
  }
  return n;
}

function deficient(accepted: readonly Variant[], policy: VariationPolicy): AxisDraw[] {
  const needs: AxisDraw[] = [];
  for (const productId of policy.productIds) {
    if (countBy(accepted, (variant) => variant.productId === productId) < policy.coverage.perProduct) {
      needs.push({ productId });
    }
  }
  for (const ratio of policy.ratios) {
    if (countBy(accepted, (variant) => variant.aspectRatio === ratio) < policy.coverage.perRatio) {
      needs.push({ aspectRatio: ratio });
    }
  }
  return needs;
}

function firstUnmetCoverage(
  variants: readonly Variant[],
  policy: VariationPolicy,
): string | undefined {
  for (const productId of policy.productIds) {
    const have = countBy(variants, (variant) => variant.productId === productId);
    if (have < policy.coverage.perProduct) {
      return `product "${productId}" has ${have} of perProduct ${policy.coverage.perProduct}`;
    }
  }
  for (const ratio of policy.ratios) {
    const have = countBy(variants, (variant) => variant.aspectRatio === ratio);
    if (have < policy.coverage.perRatio) {
      return `ratio "${ratio}" has ${have} of perRatio ${policy.coverage.perRatio}`;
    }
  }
  return undefined;
}

function genaiCalls(variants: readonly Variant[]): number {
  return variants.filter((variant) => variant.backgroundSource === "genai").length;
}

/** `frames` only on motion plans, so static plan JSON stays byte-identical. */
function framesEstimate(variants: readonly Variant[], policy: VariationPolicy): { frames?: number } {
  if (!policy.motionEnabled) return {};
  let frames = 0;
  for (const variant of variants) {
    if (variant.durationSec !== undefined) frames += variant.durationSec * MOTION_FPS;
  }
  return { frames };
}

function toPlan(briefId: string, policy: VariationPolicy, variants: readonly Variant[]): VariationPlan {
  return {
    policyHash: policy.policyHash,
    seed: policy.seed,
    variants,
    estimate: {
      creatives: variants.length,
      axisProductSize: policy.axisProductSize,
      feasible: true,
      genaiCalls: genaiCalls(variants),
      ...framesEstimate(variants, policy),
    },
    policy,
    briefId,
  };
}

