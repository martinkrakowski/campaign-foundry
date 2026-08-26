import { err, ok, SeededRandom, seedFrom, type Result } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../domain/entities/CampaignBrief.js";
import type { Variant } from "../../domain/entities/Variant.js";
import type { AspectRatioValue } from "../../domain/value-objects/AspectRatio.vo.js";
import type { VariationPlan } from "../../domain/value-objects/VariationPlan.vo.js";
import {
  DISTANCE_AXES,
  VariationPolicy,
} from "../../domain/value-objects/VariationPolicy.vo.js";

/** Re-roll bound: 64 draws from `seedFrom(briefId, index, attempt)`. */
const REPLAN_MAX_DRAWS = 64;

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
 * distance or coverage.
 */
export class PlanVariationsUseCase {
  plan(brief: CampaignBrief): Result<VariationPlan, Error> {
    const policyResult = VariationPolicy.fromBrief(brief);
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
    const accepted: Variant[] = [];
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
      return err(
        new Error(
          `Variation plan shortfall: accepted ${accepted.length} of count ${policy.count} (axisProductSize ${policy.axisProductSize}, minDistance ${policy.minDistance}).`,
        ),
      );
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

    const rng = new SeededRandom(seedFrom(plan.briefId, String(index), String(attempt)));
    const others = plan.variants.filter((_, slot) => slot !== index);
    const seed = seedFrom(plan.briefId, String(index), String(attempt));

    for (let draw = 0; draw < REPLAN_MAX_DRAWS; draw++) {
      const axes = drawAxes(rng, plan.policy, {});
      const variant: Variant = { index, seed, ...axes };
      if (!meetsMinDistance(variant, others, plan.policy.minDistance)) continue;
      const variants = plan.variants.map((current, slot) => (slot === index ? variant : current));
      if (firstUnmetCoverage(variants, plan.policy) !== undefined) continue;
      return ok({
        ...plan,
        variants,
        estimate: { ...plan.estimate, genaiCalls: genaiCalls(variants) },
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
  return {
    productId: fixed.productId ?? rng.pick(policy.productIds),
    aspectRatio: fixed.aspectRatio ?? rng.pick(policy.ratios),
    layout: rng.pick(policy.layout),
    tone: rng.pick(policy.tone),
    backgroundSource: rng.pick(policy.backgroundSource),
    paletteShift: rng.pick(policy.paletteShift),
  };
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
    },
    policy,
    briefId,
  };
}
