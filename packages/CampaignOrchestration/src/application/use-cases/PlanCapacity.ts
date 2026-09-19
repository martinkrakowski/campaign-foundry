import { SeededRandom, seedFrom } from "@campaignfoundry/shared";
import {
  DISTANCE_AXES,
  type VariationPolicy,
} from "../../domain/value-objects/VariationPolicy.vo.js";
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

/**
 * Whether this brief's occupancy describes creatives that already exist (SL-D3):
 * a tombstoned slot, or an allocation cursor that has moved past the recipe's
 * cardinality because a creative was added.
 *
 * A brief carrying neither — which includes every brief written before SL1, since
 * absent occupancy resolves to `nextIndex === count` with nothing tombstoned — is
 * indistinguishable from one with no occupancy block, and takes every path it
 * took before. That is what makes the distinction usable as a switch: it is only
 * ever true for a brief whose creatives the operator has already edited.
 */
export function hasOccupants(policy: VariationPolicy): boolean {
  return policy.occupancy.tombstoned.length > 0 || policy.occupancy.nextIndex !== policy.count;
}

/** Every combination the draw could produce, in a fixed order, so it can be searched or counted. */
export function enumerateAxes(policy: VariationPolicy): Axes[] {
  const out: Axes[] = [];
  const headlines: ReadonlyArray<string | undefined> =
    policy.headline.length > 0 ? policy.headline : [undefined];
  const anchors: ReadonlyArray<AnchorKind | undefined> =
    policy.anchor.length > 0 ? policy.anchor : [undefined];
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
                    for (const durationSec of policy.duration)
                      out.push({ ...base, motion, durationSec });
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

/**
 * Two points conflict when they are closer than the requested distance — never
 * closer than **one** axis, whatever the caller asks for (SL-D6). `DISTANCE_AXES`
 * names every axis `enumerateAxes` varies, so Hamming 0 means *the same point*:
 * a search that admitted it would pick the same combination again and again.
 *
 * Unfloored at 0 this predicate is constantly `false`, so `exhaustiveAccept`'s
 * `fits` accepts everything and its greedy returns `order[0]` `count` times —
 * measured at the ceiling as **1 distinct of 120**. Its twin in the random draw
 * is `meetsMinDistance` (`PlanVariationsUseCase.use-case.ts`), floored the same
 * way; flooring either alone leaves the other search degenerate, so the two
 * floors are one rule written at the two places the search actually asks.
 */
export function conflicts(a: Axes, b: Axes, minDistance: number): boolean {
  let distance = 0;
  for (const axis of DISTANCE_AXES) {
    if ((a as Variant)[axis] !== (b as Variant)[axis]) distance += 1;
  }
  return distance < Math.max(1, minDistance);
}

/**
 * A true upper bound on what the space can hold: the number of **lines** along
 * whichever axis has the fewest of them.
 *
 * A *line* is a set of points agreeing on every axis but one. Any two of its
 * members are Hamming 1 apart, so `conflicts` refuses the pair at every
 * `minDistance >= 2` — at most one point per line, therefore at most (number of
 * lines) points altogether. That argument runs for each axis independently, so
 * the smallest line count over `DISTANCE_AXES` is the bound.
 *
 * The lines are COUNTED from the enumerated space rather than divided out of it,
 * and that is the whole of the fix. `space.length / (largest axis)` is the same
 * number only when every line is FULL, and no brief carrying motion guarantees
 * that — the old divisor folded `|motion| × |duration| + mixStatic` into one
 * pseudo-axis, and a motion block is not a line:
 *
 * - `motion` and `durationSec` are two axes. `(kind1, 4s)` and `(kind2, 6s)`
 *   differ in **two**, so both may be chosen at `minDistance 2`. Measured on a
 *   motion-only brief with two kinds and two durations: bounded at 8 where the
 *   exact maximum is 16.
 * - a still and a clip on the same base also differ in two (`motion` and
 *   `durationSec` are both absent on a still), so `mixStatic` broke it even at
 *   one kind and one duration — bounded at 10 where the exact maximum is 12.
 * - and `motionRatios` makes a mixed plan's blocks unequal across ratios
 *   (#499's third site), where the over-division got worst: a three-ratio brief
 *   packaging motion at one was bounded at 33 while the planner seats 52.
 *
 * So the divisor erred **low** — it was never an upper bound for a brief with a
 * motion axis, and `shortfallMessage` quoted it to the operator as one, naming a
 * ceiling well under what the same brief plans.
 *
 * Counting lines cannot err that way: it is an upper bound by the argument above.
 * It stays **loose high**, which is what a line bound has always been — 56 on the
 * mixed brief whose greedy reaches 52, much as the static brief this suite
 * already trusts reports 72 against a greedy 55. That is why `capacityAt` marks
 * it `exact: false` and `shortfallMessage` says "no more than" rather than "at
 * most". Tightening it further is a different algorithm, not a different formula.
 * What changes here is only that the number is now a ceiling rather than a floor
 * wearing a ceiling's sentence — and it returns exactly the old number wherever
 * the old number was one: a static brief, and a motion brief whose block is a
 * single slot, both of which have only full lines.
 *
 * `policy` is no longer a parameter on purpose. Every axis size the divisor read
 * off it is a restatement of what `enumerateAxes` already laid down, and the two
 * restatements are what drifted; the space is the only input left.
 */
export function lineBound(space: readonly Axes[]): number {
  // `?? null` so an absent axis (a still's `motion`) is one value rather than the
  // `undefined` `JSON.stringify` drops, and quoting keeps it distinct from the
  // literal string "null".
  const coordinates = space.map((point) =>
    DISTANCE_AXES.map((axis) => JSON.stringify((point as Variant)[axis] ?? null)),
  );
  return Math.min(
    ...DISTANCE_AXES.map((_axis, index) => {
      const lines = new Set<string>();
      for (const point of coordinates) {
        // Blanking one coordinate collapses a line to a single key: the number of
        // distinct keys IS the number of lines along that axis.
        lines.add(point.map((value, other) => (other === index ? "*" : value)).join(" "));
      }
      return lines.size;
    }),
  );
}

/**
 * Size of a maximum independent set, by branch and bound over bitsets. Returns
 * undefined when the step budget runs out, so the caller can fall back to a bound.
 */
export function maximumIndependentSet(
  adjacency: readonly bigint[],
  stepLimit: number,
): number | undefined {
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
 * Why an exact maximum was not available. The two are not the same kind of event
 * and must not be read as one:
 *
 * - `space-too-large` is a DESIGN limit. Past `EXACT_CAPACITY_MAX_SPACE` the bitset
 *   search is not attempted at all, and every such space reports a bound. That is
 *   the intended, permanent behaviour for a big brief.
 * - `budget-exhausted` is a CLIFF. The search started, ran out of steps and did not
 *   close — so the same call would have been exact with a larger budget, and *is*
 *   exact for a slightly smaller space. Nothing in `{ max, exact }` says which of
 *   the two happened, or that the second one is a step limit away from answering.
 */
export type InexactCapacityReason = "space-too-large" | "budget-exhausted";

/**
 * Raised by `exactCapacityAt` when no exact maximum is available.
 *
 * It exists because the fallback is not merely approximate, it is *specifically*
 * `lineBound(space)` — so a caller that wanted an exact maximum in order to check
 * the bound against it gets handed the bound, compares it with itself and passes.
 * Measured on #502's own 56-point mixed space: at the production budget `capacityAt`
 * reports `{ max: 28, exact: false }` with `lineBound === 28`, while the true
 * maximum is 24. `bound >= max` reads 28 >= 28 and is vacuously true.
 */
export class InexactCapacityError extends Error {
  readonly reason: InexactCapacityReason;
  /** The number `capacityAt` returns instead — always `lineBound(space)`. */
  readonly bound: number;
  readonly spaceSize: number;
  readonly stepLimit: number;

  constructor(reason: InexactCapacityReason, bound: number, spaceSize: number, stepLimit: number) {
    super(
      reason === "space-too-large"
        ? `No exact capacity for a space of ${spaceSize} points: past EXACT_CAPACITY_MAX_SPACE ` +
            `(${EXACT_CAPACITY_MAX_SPACE}) the exact search is not attempted. The line bound is ` +
            `${bound} — ask capacityAt for it, and never compare it against itself.`
        : `No exact capacity for a space of ${spaceSize} points: the branch and bound did not ` +
            `close within ${stepLimit} steps. The line bound is ${bound} — a larger step limit ` +
            `would answer exactly, and comparing the bound against this fallback compares it ` +
            `against itself.`,
    );
    this.name = "InexactCapacityError";
    this.reason = reason;
    this.bound = bound;
    this.spaceSize = spaceSize;
    this.stepLimit = stepLimit;
  }
}

/** Either an exact maximum, or the bound together with the reason it is only a bound. */
type CapacityOutcome =
  | { readonly kind: "exact"; readonly max: number }
  | { readonly kind: "inexact"; readonly bound: number; readonly reason: InexactCapacityReason };

/**
 * The one computation behind both `capacityAt` and `exactCapacityAt`, so the
 * degrading caller and the refusing one cannot disagree about what happened.
 */
function capacityOutcome(
  space: readonly Axes[],
  policy: VariationPolicy,
  stepLimit: number,
): CapacityOutcome {
  if (policy.minDistance <= 1) return { kind: "exact", max: space.length };
  if (space.length > EXACT_CAPACITY_MAX_SPACE)
    return { kind: "inexact", bound: lineBound(space), reason: "space-too-large" };
  const adjacency = space.map((a, i) => {
    let bits = 0n;
    space.forEach((b, j) => {
      if (i !== j && conflicts(a, b, policy.minDistance)) bits |= 1n << BigInt(j);
    });
    return bits;
  });
  const exact = maximumIndependentSet(adjacency, stepLimit);
  return exact === undefined
    ? { kind: "inexact", bound: lineBound(space), reason: "budget-exhausted" }
    : { kind: "exact", max: exact };
}

/**
 * The most variants this space can hold pairwise at least `minDistance` apart:
 * exact for small spaces, otherwise the line bound (a true upper bound either way).
 *
 * "Either way" is a claim `lineBound` only now earns: while it divided by a motion
 * pseudo-axis it returned numbers *below* the exact maximum this same function
 * computes one branch up, so the bounded branch contradicted the exact one.
 *
 * **This function degrades, and it has to**: `shortfallMessage` must name a ceiling
 * for whatever brief an operator actually wrote, and a loose ceiling is a far better
 * answer there than a thrown error. The price is that `exact: false` is easy to
 * ignore and the number it hides is `lineBound(space)` itself — so a caller that
 * wants the maximum as an ORACLE must use `exactCapacityAt`, which refuses rather
 * than handing back the very number the oracle was meant to check.
 */
export function capacityAt(
  space: readonly Axes[],
  policy: VariationPolicy,
  stepLimit: number = EXACT_CAPACITY_STEP_LIMIT,
): { max: number; exact: boolean } {
  const outcome = capacityOutcome(space, policy, stepLimit);
  return outcome.kind === "exact"
    ? { max: outcome.max, exact: true }
    : { max: outcome.bound, exact: false };
}

/**
 * The exact maximum, or nothing at all.
 *
 * The same computation as `capacityAt` with the opposite failure mode: where that
 * one silently substitutes `lineBound(space)`, this one throws `InexactCapacityError`
 * naming which limit was hit, what the bound would have been, and — for the
 * exhausted case — that a larger budget would answer.
 *
 * Use it wherever the number is a CLAIM ABOUT THE SPACE rather than a sentence for
 * an operator. The measured case it exists for: #502's 56-point mixed space exhausts
 * the production budget and falls back to 28, which is exactly `lineBound(space)`, so
 * `expect(lineBound(space)).toBeGreaterThanOrEqual(capacityAt(space, policy).max)`
 * asserts 28 >= 28 and passes without ever computing the maximum it claims to bound
 * (24, at a five-million-step budget). Nothing in `{ max, exact }` makes that loud.
 * A throw does.
 */
export function exactCapacityAt(
  space: readonly Axes[],
  policy: VariationPolicy,
  stepLimit: number = EXACT_CAPACITY_STEP_LIMIT,
): number {
  const outcome = capacityOutcome(space, policy, stepLimit);
  if (outcome.kind === "inexact")
    throw new InexactCapacityError(outcome.reason, outcome.bound, space.length, stepLimit);
  return outcome.max;
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
 *
 * It targets `policy.count` and assigns the slots `0 … count-1`, which is sound
 * only because the caller refuses to take this path once the brief has occupants
 * (`hasOccupants`): the search re-chooses the whole set from a reshuffled order,
 * so it cannot preserve a slot that already exists.
 */
export function exhaustiveAccept(
  space: readonly Axes[],
  policy: VariationPolicy,
  briefId: string,
  deficient: (accepted: readonly Variant[], policy: VariationPolicy) => readonly AxisNeed[],
): Variant[] {
  let best: Axes[] = [];
  for (let restart = 0; restart < EXHAUSTIVE_RESTARTS && best.length < policy.count; restart += 1) {
    const rng = new SeededRandom(
      seedFrom(briefId, String(policy.seed), "exhaustive", String(restart)),
    );
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
  return best.map((axes, index) => ({
    index,
    seed: seedFrom(briefId, String(index), "0"),
    ...axes,
  }));
}

/**
 * Why the draw fell short, and what would fix it.
 *
 * The target is the number of slots ALLOCATED (`occupancy.nextIndex`), not the
 * recipe's `count`: once a creative has been added the two differ, and the
 * operator's request was for the slot, not for the recipe. They are equal for
 * every brief that carries no occupancy, so the sentence is unchanged there.
 *
 * With occupants the message also has to say that the existing creatives are not
 * negotiable — they keep their draw (see `PlanVariationsUseCase`'s replay), so a
 * shortfall is about the slots still to allocate and one of the remedies is to
 * delete a creative. This is §7's "refused loudly, naming the shortfall": the
 * alternative, taking the exhaustive search, would silently reshuffle every
 * creative the operator already has.
 */
export function shortfallMessage(
  policy: VariationPolicy,
  space: readonly Axes[],
  accepted: number,
): string {
  const { max, exact } = capacityAt(space, policy);
  const singleRatio = policy.motionEnabled && !policy.mixStatic && policy.ratios.length === 1;
  const why = singleRatio
    ? ` — every motion platform is ${policy.ratios[0]}, so the aspect ratio cannot vary`
    : "";
  const occupied = hasOccupants(policy)
    ? `Existing creatives keep their draw (${accepted} of ${policy.occupancy.nextIndex} slots ` +
      `are already occupied), so the shortfall is in the slots still to allocate. `
    : "";
  const remedies = [`lower count to ${max}`];
  if (hasOccupants(policy)) remedies.unshift("delete a creative");
  if (policy.minDistance > 1)
    remedies.push(`lower minDistance (at 1 the maximum is ${space.length})`);
  remedies.push("add axis values (another palette shift, layout, tone, motion kind or duration)");
  return (
    `Variation plan shortfall: accepted ${accepted} of count ${policy.occupancy.nextIndex}. ` +
    occupied +
    `At minDistance ${policy.minDistance} this brief can yield ${exact ? "at most" : "no more than"} ${max} ` +
    `distinct variants (${space.length} combinations${why}). To fix: ${remedies.join(", ")}.`
  );
}
