import { err, ok, SeededRandom, seedFrom, type Result } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../domain/entities/CampaignBrief.js";
import type { Variant } from "../../domain/entities/Variant.js";
import type { AspectRatioValue } from "../../domain/value-objects/AspectRatio.vo.js";
import type { VariationPlan } from "../../domain/value-objects/VariationPlan.vo.js";
import { VariationPolicy } from "../../domain/value-objects/VariationPolicy.vo.js";

/** Hamming axes — a candidate must differ in at least `minDistance` of these. */
const DISTANCE_AXES = [
  "productId",
  "aspectRatio",
  "layout",
  "tone",
  "backgroundSource",
  "paletteShift",
] as const;

/** Re-roll bound: 64 draws from `seedFrom(briefId, index, attempt)`. */
const REPLAN_MAX_DRAWS = 64;

interface AxisDraw {
  readonly productId?: string;
  readonly aspectRatio?: AspectRatioValue;
}

/**
 * PlanVariationsUseCase — pure, synchronous, seeded planner.
 *
 * `plan` greedy-accepts at `minDistance` after coverage draws, then random
 * draws, with a hard cap of `count × 3` candidates. `replan` replaces one slot.
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

    const budget = policy.count * 3;
    const rng = new SeededRandom(seedFrom(brief.id, String(policy.seed)));
    const accepted: Variant[] = [];
    let drawn = 0;

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

    for (let n = 0; n < policy.coverage.perProduct && remaining(); n++) {
      for (const productId of policy.productIds) {
        if (!remaining()) break;
        addCandidate({ productId });
      }
    }

    for (const ratio of policy.ratios) {
      if (!remaining()) break;
      const have = accepted.filter((variant) => variant.aspectRatio === ratio).length;
      if (have >= policy.coverage.perRatio) continue;
      addCandidate({ aspectRatio: ratio });
    }

    while (remaining()) addCandidate({});

    if (accepted.length < policy.count) {
      return err(
        new Error(
          `Variation plan shortfall: accepted ${accepted.length} of count ${policy.count} (axisProductSize ${policy.axisProductSize}).`,
        ),
      );
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
      if (meetsMinDistance(variant, others, plan.policy.minDistance)) {
        const variants = plan.variants.map((current, slot) => (slot === index ? variant : current));
        return ok({
          ...plan,
          variants,
          estimate: { ...plan.estimate, genaiCalls: genaiCalls(variants) },
        });
      }
    }

    return err(
      new Error(
        `replan exhausted ${REPLAN_MAX_DRAWS} draws for index ${index} without satisfying minDistance ${plan.policy.minDistance}.`,
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
