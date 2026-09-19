import { err, ok, SeededRandom, seedFrom, type Result } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../domain/entities/CampaignBrief.js";
import type { Variant } from "../../domain/entities/Variant.js";
import type { AspectRatioValue } from "../../domain/value-objects/aspect-ratios.js";
import { MOTION_FPS, type MotionKind } from "../../domain/value-objects/MotionKind.vo.js";
import type { VariationPlan } from "../../domain/value-objects/VariationPlan.vo.js";
import {
  DISTANCE_AXES,
  hashCopy,
  VariationPolicy,
  type PlanInput,
  type PolicyHasher,
} from "../../domain/value-objects/VariationPolicy.vo.js";

/** Re-roll bound: 64 draws from `seedFrom(briefId, index, attempt)`. */
import {
  EXHAUSTIVE_MAX_SPACE,
  enumerateAxes,
  exhaustiveAccept,
  shortfallMessage,
} from "./PlanCapacity.js";

const REPLAN_MAX_DRAWS = 64;

/**
 * The draws one slot is guaranteed before the planner may call it impossible.
 *
 * Deliberately the same number as `REPLAN_MAX_DRAWS`, and for the same reason:
 * re-roll already asks "how many draws does ONE slot get against the occupants
 * it must clear?" and answers 64. An appended slot asks the identical question,
 * so it gets the identical answer rather than a second, tuned constant.
 */
const PER_SLOT_MIN_DRAWS = REPLAN_MAX_DRAWS;

interface AxisDraw {
  readonly productId?: string;
  readonly aspectRatio?: AspectRatioValue;
}

/**
 * PlanVariationsUseCase — pure, synchronous, seeded planner.
 *
 * `plan` round-robins deficient coverage axes, then fills the **allocated** slots,
 * greedy-accepting at Hamming `minDistance`, with a hard cap of `allocated × 3`
 * candidates. Coverage is a property of the accepted set. `replan` replaces one
 * slot without breaking distance or coverage. `input` carries what the brief
 * cannot: `headlines` (the approved copy pool) and `motionRatios` (the ratios the
 * requested motion platforms package) — both resolved into the policy at plan
 * time; the stored policy carries them for `replan`.
 *
 * ## Slots are monotonic, and the draw is a replay (SL-D3, SL-D5)
 *
 * A creative's identity is its slot — `productId` + `index` (`Variant.ts:10`) —
 * and its seed is `seedFrom(briefId, index, attempt)`. The index used to be the
 * accepted **count**, so it compacted: delete slot 2, replan the same `count`,
 * and index 2 was reborn with its old seed and (being the third accepted draw)
 * its old axes. That compaction was the whole of the recreate-on-delete bug.
 *
 * What replaces it is not "skip the tombstoned index" — that is not enough, and
 * the reason is worth stating because it is the only thing the two designs
 * disagree about. The axes come from **one sequential RNG consumed per
 * candidate**, so a slot's axes are a function of its *position in the draw*,
 * not of its index. Skip index 2 without consuming its draw and slot 3 receives
 * the third draw where it used to receive the fourth: same index, same seed,
 * **different axes** — a different picture at `…/v3.png`. §7's first line
 * ("deleting a creative leaves the others byte-identical") would fail.
 *
 * So the draw **replays the whole allocation history**, `[0, occupancy.nextIndex)`,
 * exactly as it always did; a tombstoned slot is still drawn, still spends its
 * budget and still occupies the distance and coverage sets. Occupancy decides
 * only which slots are *emitted*. Deleting a slot therefore leaves every other
 * slot's `index`, `seed` and axes untouched — deep-equal, not merely similar —
 * and an added slot is `nextIndex`, above every index ever used, drawn against
 * the history that precedes it (SL-D4's "append against occupants": the history
 * is a superset of the live occupants, so a candidate too close to any existing
 * creative is rejected).
 *
 * A brief with no `variation.occupancy` resolves to `nextIndex === count` with
 * nothing tombstoned (`resolveOccupancy`), so every line below is the old line
 * and every existing plan is byte-identical.
 */
export class PlanVariationsUseCase {
  constructor(private readonly hasher: PolicyHasher) {}

  plan(brief: CampaignBrief, input: PlanInput = {}): Result<VariationPlan, Error> {
    const policyResult = VariationPolicy.fromBrief(brief, input, this.hasher);
    if (!policyResult.success) return policyResult;
    const policy = policyResult.value;

    // How many slots the draw must fill: every index ever allocated, tombstoned
    // ones included, because the draw is a replay (see the class comment). Equal
    // to `count` for a brief that carries no occupancy.
    const allocated = policy.occupancy.nextIndex;
    const live = new Set(policy.occupancy.liveIndices);

    if (policy.axisProductSize < allocated) {
      return err(
        new Error(
          `Variation count ${allocated} exceeds axisProductSize ${policy.axisProductSize}.`,
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

    const budget = allocated * 3;
    const rng = new SeededRandom(seedFrom(brief.id, String(policy.seed)));
    /**
     * Every slot the draw has allocated so far, tombstoned ones included — the
     * allocation history, not the emitted set. It is dense over `[0, cursor)`,
     * which is what makes the replay reproducible.
     */
    let history: Variant[] = [];
    /** The allocation cursor (SL-D3): it only ever advances, and never revisits a slot. */
    let cursor = 0;
    let drawn = 0;
    let turn = 0;
    /** Draws spent on the slot at `cursor`, reset each time one is accepted. */
    let slotDraws = 0;

    // The shared pool `allocated × 3` is spent in order, so an APPENDED slot —
    // the last one allocated, and the most constrained, since it must clear every
    // occupant before it — inherits whatever the replay of the operator's
    // existing slots left behind. Often that is nothing. And because the
    // exhaustive fallback below is deliberately closed once a slot has been added
    // (re-choosing would move creatives the operator already has), the starvation
    // surfaces as "this brief cannot fit" when the truth is "this draw ran out of
    // turns". Measured over a 4–20 × 12-seed × 2-distance sweep: 42 briefs whose
    // dense plan succeeds refuse on a single add, and 27 of those place fine
    // given more turns at the new slot.
    //
    // So an appended slot gets a FLOOR of its own draws, and the floor applies
    // ONLY at `cursor >= policy.count`. Below that the loop is the old loop,
    // instruction for instruction: a brief with no add has `allocated === count`,
    // never reaches the condition, and keeps its exact draw sequence — including
    // whether it falls through to the exhaustive search, which several plans rely
    // on to be reproducible. Widening the floor to every slot would let the
    // random draw reach plans the fallback used to serve, quietly changing them.
    const remaining = (): boolean =>
      cursor < allocated &&
      (drawn < budget || (cursor >= policy.count && slotDraws < PER_SLOT_MIN_DRAWS));

    const addCandidate = (fixed: AxisDraw): void => {
      drawn += 1;
      slotDraws += 1;
      const axes = drawAxes(rng, policy, fixed);
      const index = cursor;
      const variant: Variant = {
        index,
        seed: seedFrom(brief.id, String(index), "0"),
        ...axes,
      };
      // The occupants a candidate must keep its distance from are every slot
      // already allocated (SL-D4) — for an append, that is the whole existing set.
      if (meetsMinDistance(variant, history, policy.minDistance)) {
        history.push(variant);
        cursor += 1;
        slotDraws = 0;
      }
    };

    while (remaining()) {
      const needs = deficient(history, policy);
      if (needs.length > 0) {
        addCandidate(needs[turn % needs.length]);
        turn += 1;
      } else {
        addCandidate({});
      }
    }

    if (cursor < allocated) {
      // The random draw (kept first so every plan it can satisfy stays golden) has a
      // budget of 3 × allocated, which is hopeless in a tight space — a motion-only brief
      // sits at one aspect ratio, since every motion platform is 9:16. Search the
      // whole space instead, seeded, before deciding the brief really cannot fit.
      //
      // It answers one question, though: "choose `policy.count` points from
      // scratch". That is the right question exactly while `allocated === count`
      // — a dense brief, and a DELETE, which leaves `nextIndex` alone. The chosen
      // set is then identical before and after the delete (occupancy is not in
      // the policy hash and not an input to the search), so the survivors of a
      // brief that needed this path are byte-identical too.
      //
      // Once a slot has been ADDED, `allocated > count` and the question no
      // longer matches: re-choosing from a reshuffled order would move every
      // creative the operator already has, to make room for one more. Refuse
      // loudly instead, naming the shortfall (§7).
      //
      // CONSTRAINT ON THE GESTURES (SL4): add advances `nextIndex` only, delete
      // appends a tombstone only, and NEITHER touches `count` — SL-D5's reading,
      // that `count` is the recipe's target cardinality and occupancy is what
      // exists. This test breaks in both directions otherwise: an add that also
      // raised `count` would make the two equal again and re-open the search on
      // the very gesture it guards, and a delete that lowered `count` would make
      // them differ and strand a brief whose plan this search produced.
      const space = enumerateAxes(policy);
      const exhaustive =
        space.length <= EXHAUSTIVE_MAX_SPACE && allocated === policy.count
          ? exhaustiveAccept(space, policy, brief.id, deficient)
          : history;
      if (exhaustive.length < allocated) {
        return err(
          new Error(shortfallMessage(policy, space, Math.max(history.length, exhaustive.length))),
        );
      }
      history = exhaustive; // the coverage check below applies to either search
    }

    // Occupancy decides what is emitted; the history decided what was drawn.
    const variants = history.filter((variant) => live.has(variant.index));

    const unmet = firstUnmetCoverage(variants, policy);
    if (unmet !== undefined) {
      return err(new Error(`Variation plan coverage unmet: ${unmet}${tombstoneNote(policy)}.`));
    }

    const copyHash = hashCopy(brief, this.hasher);
    return ok(toPlan(brief.id, policy, variants, hasSceneBackgrounds(brief), copyHash));
  }

  /**
   * Re-roll one slot, keeping its `index` and restamping its seed from `attempt`.
   *
   * `index` is a **slot**, not a position in `plan.variants` (H1). With holes the
   * two differ — a plan of slots `0, 1, 3` has `length` 3, so the old
   * `index >= plan.variants.length` bound refused slot 3, and `plan.variants[3]`
   * was `undefined`. Every lookup here resolves the slot first and works in
   * positions afterwards.
   */
  replan(plan: VariationPlan, index: number, attempt: number): Result<VariationPlan, Error> {
    const position = plan.variants.findIndex((variant) => variant.index === index);
    if (!Number.isInteger(index) || index < 0 || position < 0) {
      return err(new Error(`Invalid variant index ${index}.`));
    }
    if (!Number.isInteger(attempt) || attempt < 1) {
      return err(new Error(`replan attempt must be an integer >= 1 (received ${attempt}).`));
    }

    const occupant = plan.variants[position];
    const rng = new SeededRandom(seedFrom(plan.briefId, String(index), String(attempt)));
    const others = plan.variants.filter((_, slot) => slot !== position);
    const seed = seedFrom(plan.briefId, String(index), String(attempt));

    for (let draw = 0; draw < REPLAN_MAX_DRAWS; draw++) {
      const axes = drawAxes(rng, plan.policy, {
        productId: occupant.productId,
        aspectRatio: occupant.aspectRatio,
      });
      const variant: Variant = { index, seed, ...axes };
      if (!meetsMinDistance(variant, others, plan.policy.minDistance)) continue;
      const variants = plan.variants.map((current, slot) =>
        slot === position ? variant : current,
      );
      if (firstUnmetCoverage(variants, plan.policy) !== undefined) continue;
      return ok({
        ...plan,
        variants,
        estimate: {
          ...plan.estimate,
          genaiCalls: genaiCalls(variants),
          ...framesEstimate(variants, plan.policy),
        },
      });
    }

    return err(
      new Error(
        `replan exhausted ${REPLAN_MAX_DRAWS} draws for index ${index} without satisfying minDistance ${plan.policy.minDistance} and coverage.`,
      ),
    );
  }
}

/**
 * Coverage counts the slots that EXIST, so a delete can put a brief below its
 * own floor. Say which delete did it; silence here reads as a planner bug.
 * Empty for a brief with no tombstones, so every pre-SL2 message is unchanged.
 */
function tombstoneNote(policy: VariationPolicy): string {
  const { tombstoned } = policy.occupancy;
  if (tombstoned.length === 0) return "";
  return ` (${tombstoned.length} deleted slot${tombstoned.length === 1 ? "" : "s"}: ${tombstoned.join(", ")})`;
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
    ...drawAnchor(rng, policy),
    ...drawMotion(rng, policy, aspectRatio),
  };
}

/** Draw a pooled headline, so briefs without the axis leave the rng sequence untouched. */
function drawHeadline(rng: SeededRandom, policy: VariationPolicy): Pick<Variant, "headline"> {
  return policy.headline.length === 0 ? {} : { headline: rng.pick(policy.headline) };
}

/** Draw the anchor axis the same way: briefs without it consume no draws (goldens unchanged). */
function drawAnchor(rng: SeededRandom, policy: VariationPolicy): Pick<Variant, "anchor"> {
  return policy.anchor.length === 0 ? {} : { anchor: rng.pick(policy.anchor) };
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

/**
 * The random draw's acceptance test, floored at one axis (SL-D6). `DISTANCE_AXES`
 * names every axis `drawAxes` varies, so Hamming 0 means *the same point*: at an
 * unfloored 0 the draw samples **with replacement** and `count = axisProductSize`
 * stops meaning "every combination" — measured 83 distinct of 120. The floor is
 * the invariant, not the bound: `VariationPolicy.fromBrief` refuses a policy
 * below 1, and this says the search would refuse it anyway. Its twin on the
 * exhaustive path is `conflicts` (`PlanCapacity.ts`) — see the note there.
 */
function meetsMinDistance(
  candidate: Variant,
  accepted: readonly Variant[],
  minDistance: number,
): boolean {
  const floor = Math.max(1, minDistance);
  return accepted.every((variant) => hamming(candidate, variant) >= floor);
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
    if (
      countBy(accepted, (variant) => variant.productId === productId) < policy.coverage.perProduct
    ) {
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
function framesEstimate(
  variants: readonly Variant[],
  policy: VariationPolicy,
): { frames?: number } {
  if (!policy.motionEnabled) return {};
  let frames = 0;
  for (const variant of variants) {
    if (variant.durationSec !== undefined) frames += variant.durationSec * MOTION_FPS;
  }
  return { frames };
}

/**
 * Whether the brief's timeline names any per-beat scene at all (VE5b2). Since
 * VE5a a scene is an uploaded asset path, never a generated one — so this
 * never adds to `genaiCalls` — but the estimate sentence still needs to know
 * whether to say so. `false` (never present as `false`, see `toPlan`) for a
 * brief with no timeline or one naming no backgrounds.
 */
function hasSceneBackgrounds(brief: CampaignBrief): boolean {
  return brief.copy?.timeline?.beats.some((beat) => beat.background !== undefined) ?? false;
}

function toPlan(
  briefId: string,
  policy: VariationPolicy,
  variants: readonly Variant[],
  sceneBackgrounds: boolean,
  copyHash: string,
): VariationPlan {
  return {
    policyHash: policy.policyHash,
    copyHash,
    seed: policy.seed,
    variants,
    estimate: {
      creatives: variants.length,
      axisProductSize: policy.axisProductSize,
      feasible: true,
      genaiCalls: genaiCalls(variants),
      ...framesEstimate(variants, policy),
      // Present only when true (VE5b2): a brief with no scene ever moves this
      // key into existence, so every plan JSON predating VE5b2 stays byte-identical.
      ...(sceneBackgrounds ? { sceneBackgrounds: true } : {}),
    },
    policy,
    briefId,
  };
}
