import { describe, test, expect } from "vitest";
import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";
import type { Variant } from "../../../domain/entities/Variant.js";
import {
  DISTANCE_AXES,
  VariationPolicy,
  type PlanInput,
} from "../../../domain/value-objects/VariationPolicy.vo.js";
import { nodeCryptoPolicyHasher } from "../../../infrastructure/index.js";
import {
  EXACT_CAPACITY_MAX_SPACE,
  capacityAt,
  enumerateAxes,
  lineBound,
  shortfallMessage,
  type Axes,
} from "../PlanCapacity.js";
import { PlanVariationsUseCase } from "../PlanVariationsUseCase.use-case.js";

/**
 * `lineBound` was the third site of #499's defect, and re-deriving it found the
 * defect wider than #499 could see from the outside.
 *
 * #499's two sites count the SPACE. `lineBound` bounds the CAPACITY of that space
 * at `minDistance >= 2`, and it did so by dividing the space by its largest axis —
 * reading `|motion| × |duration| + mixStatic` off the policy as if it were one
 * axis. It is not. `motion` and `durationSec` are two of `DISTANCE_AXES`, so two
 * members of a motion block can differ in two axes and both be chosen; and a
 * still differs from a clip in both at once. Dividing by the block therefore
 * claimed a ceiling BELOW what the space holds.
 *
 * That makes the direction of the error the thing to state plainly. A bound that
 * is too high admits impossible requests, which then fail later and less clearly.
 * A bound that is too low refuses possible ones — and `shortfallMessage` quotes
 * this number to the operator as "this brief can yield no more than N", with
 * "lower count to N" as the remedy. The old code erred **low**, on every brief
 * carrying a motion axis. These tests pin both directions: the refusal that
 * should not happen, and the refusal that still must.
 *
 * Every expectation is computed from the enumerated space or from `capacityAt`'s
 * exact branch-and-bound maximum. There is no hand-written ceiling to update.
 */

const brief = (over: Record<string, unknown> = {}): CampaignBrief =>
  ({
    id: "bound",
    targetRegion: "DE",
    targetAudience: "a",
    campaignMessage: "Hi",
    products: [
      { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" },
      { id: "beta", name: "B", primaryColor: "#E0218A", logoPath: "b.png" },
    ],
    mode: "variation",
    ...over,
  }) as unknown as CampaignBrief;

const policyOf = (over: Record<string, unknown>, input: PlanInput = {}): VariationPolicy => {
  const result = VariationPolicy.fromBrief(brief(over), input, nodeCryptoPolicyHasher);
  if (!result.success) throw result.error;
  return result.value;
};

const reelOnly: PlanInput = { motionRatios: ["9:16"] };

/**
 * `capacityAt`'s production step budget exhausts on the 56-point mixed space and
 * falls back to the bound, which would make the oracle compare the bound against
 * itself. Measured: the branch and bound closes it in 136ms at five million.
 */
const EXACT_ORACLE_STEPS = 5_000_000;

/**
 * The divisor this lane replaced, reimplemented here so "moved" and "unchanged"
 * are both assertable without a literal. It is a copy on purpose: reverting the
 * source must not quietly move the thing the source is compared against.
 */
const divisorForm = (policy: VariationPolicy, space: readonly Axes[]): number =>
  Math.floor(
    space.length /
      Math.max(
        policy.productIds.length,
        policy.ratios.length,
        policy.layout.length,
        policy.tone.length,
        policy.backgroundSource.length,
        policy.paletteShift.length,
        Math.max(1, policy.headline.length),
        Math.max(1, policy.anchor.length),
        policy.motionEnabled
          ? policy.motion.length * policy.duration.length + (policy.mixStatic ? 1 : 0)
          : 1,
      ),
  );

const hamming = (a: Axes, b: Axes): number =>
  DISTANCE_AXES.reduce(
    (distance, axis) => distance + ((a as Variant)[axis] !== (b as Variant)[axis] ? 1 : 0),
    0,
  );

const closestPair = (points: readonly Axes[]): number => {
  let closest: number = DISTANCE_AXES.length;
  for (let i = 0; i < points.length; i += 1)
    for (let j = i + 1; j < points.length; j += 1)
      closest = Math.min(closest, hamming(points[i], points[j]));
  return closest;
};

/**
 * The defect's own brief. Three ratios requested, motion packaged at 9:16 alone,
 * two motion kinds and two durations, three palette shifts — 168 points, which is
 * past `EXACT_CAPACITY_MAX_SPACE`, so `capacityAt` reports the BOUND rather than
 * an exact maximum. That is the regime where the number reaches the operator.
 */
const mixedBrief = (count: number): Record<string, unknown> => ({
  variation: {
    count,
    seed: 7,
    minDistance: 2,
    axes: {
      paletteShift: [0, 0.1, 0.2],
      motion: ["ken-burns-in", "ken-burns-out"],
      duration: [4, 6],
    },
  },
  output: { formats: ["static", "motion"], platforms: ["instagram-feed", "instagram-reel"] },
});

describe("a mixed plan has no uniform motion axis, so the old divisor was not a bound", () => {
  test("the refusal that should not happen — a count the old divisor rules out, planned", () => {
    const wanted = 40;
    const policy = policyOf(mixedBrief(wanted), reelOnly);
    const space = enumerateAxes(policy);

    // The bounded regime, and the space the two sites #499 fixed already agree on.
    expect(space.length).toBeGreaterThan(EXACT_CAPACITY_MAX_SPACE);
    expect(space.length).toBe(policy.axisProductSize);

    // What the operator used to be told this brief could hold, and what they asked for.
    expect(divisorForm(policy, space)).toBeLessThan(wanted);

    // What the planner actually does with that request.
    const planned = new PlanVariationsUseCase(nodeCryptoPolicyHasher).plan(
      brief(mixedBrief(wanted)),
      reelOnly,
    );
    expect(planned.success).toBe(true);
    if (!planned.success) return;
    expect(planned.value.variants).toHaveLength(wanted);
    expect(closestPair(planned.value.variants)).toBeGreaterThanOrEqual(2);

    // So the ceiling quoted to the operator has to cover it. Under the divisor it
    // reads 33 against a plan of 40, and `shortfallMessage` would offer
    // "lower count to 33" for a brief that just seated every one of the 40.
    const reported = capacityAt(space, policy);
    expect(reported.exact).toBe(false);
    expect(reported.max).toBeGreaterThanOrEqual(planned.value.variants.length);
  });

  test("the refusal that must still happen — an impossible count, named", () => {
    // The whole space at minDistance 2: every point has neighbours one axis away,
    // so this cannot be seated, whatever the bound says.
    const policy = policyOf(mixedBrief(168), reelOnly);
    const space = enumerateAxes(policy);
    const impossible = space.length;
    expect(policy.count).toBe(impossible);

    const planned = new PlanVariationsUseCase(nodeCryptoPolicyHasher).plan(
      brief(mixedBrief(impossible)),
      reelOnly,
    );
    expect(planned.success).toBe(false);
    if (planned.success) return;

    // The shortfall names the ceiling, and the ceiling is the bound — not a
    // literal, so a change in either the enumerator or the bound shows up here.
    const ceiling = lineBound(space);
    expect(ceiling).toBeLessThan(impossible);
    expect(planned.error.message).toContain(`no more than ${ceiling} distinct variants`);
    expect(planned.error.message).toContain(`lower count to ${ceiling}`);
    expect(planned.error.message).toContain(`${impossible} combinations`);
    // The message is `shortfallMessage`'s, and the partial plan it reports having
    // seated is itself already past the ceiling the old divisor quoted: 52 against
    // 33, inside the very sentence that refuses.
    const accepted = Number(/accepted (\d+) of count/.exec(planned.error.message)?.[1]);
    expect(accepted).toBeGreaterThan(divisorForm(policy, space));
    expect(planned.error.message).toBe(shortfallMessage(policy, space, accepted));
  });
});

/**
 * Soundness, against the only oracle that settles it: `capacityAt`'s exact
 * branch-and-bound maximum over the same enumerated space. Kept to spaces at or
 * under `EXACT_CAPACITY_MAX_SPACE`, where that branch runs and finishes.
 */
const smallShapes: ReadonlyArray<readonly [string, Record<string, unknown>, PlanInput]> = [
  [
    "mixed, two kinds and two durations at one packaged ratio",
    {
      variation: {
        count: 2,
        minDistance: 2,
        axes: { motion: ["ken-burns-in", "ken-burns-out"], duration: [4, 6] },
      },
      output: { formats: ["static", "motion"], platforms: ["instagram-feed", "instagram-reel"] },
    },
    reelOnly,
  ],
  [
    "mixed, one kind and one duration at one packaged ratio",
    {
      variation: { count: 2, minDistance: 2, axes: { motion: ["ken-burns-in"], duration: [4] } },
      output: { formats: ["static", "motion"], platforms: ["instagram-feed", "instagram-reel"] },
    },
    reelOnly,
  ],
  [
    "motion only, two kinds and two durations",
    {
      variation: {
        count: 2,
        minDistance: 2,
        axes: { motion: ["ken-burns-in", "ken-burns-out"], duration: [4, 6] },
      },
      output: { formats: ["motion"], platforms: ["instagram-reel"] },
    },
    reelOnly,
  ],
];

describe("the bound is a bound", () => {
  test.each(smallShapes)("%s — it covers the exact maximum", (_name, over, input) => {
    const policy = policyOf(over, input);
    const space = enumerateAxes(policy);
    expect(space.length).toBeLessThanOrEqual(EXACT_CAPACITY_MAX_SPACE);
    expect(space.length).toBe(policy.axisProductSize);

    const exact = capacityAt(space, policy, EXACT_ORACLE_STEPS);
    expect(exact.exact).toBe(true);
    expect(lineBound(space)).toBeGreaterThanOrEqual(exact.max);
    // And the shape of the old error: below it, on every one of these.
    expect(divisorForm(policy, space)).toBeLessThan(exact.max);
  });
});

describe("a plan with only full lines keeps the number it had", () => {
  test("a static brief is unmoved", () => {
    const policy = policyOf({
      variation: {
        count: 2,
        minDistance: 2,
        axes: {
          background: { source: ["procedural", "asset-pool", "genai"] },
          paletteShift: [0, 0.1, 0.2],
        },
      },
      output: { formats: ["static"] },
    });
    const space = enumerateAxes(policy);
    // No motion axis, so every line is full and the two forms are one number.
    expect(lineBound(space)).toBe(divisorForm(policy, space));
    expect(lineBound(space)).toBe(space.length / 3);
  });

  test("a motion brief whose block is a single slot is unmoved", () => {
    // One kind, one duration, no still: the block is one slot, so it was never a
    // pseudo-axis and the divisor was already the palette. This is the `tight`
    // fixture the rest of the suite is pinned on, at its long-standing 8.
    const policy = policyOf(
      {
        variation: {
          count: 8,
          minDistance: 2,
          axes: { paletteShift: [0, 0.1, 0.2], motion: ["ken-burns-out"], duration: [5] },
        },
        output: { formats: ["motion"], platforms: ["instagram-reel"] },
      },
      reelOnly,
    );
    const space = enumerateAxes(policy);
    expect(lineBound(space)).toBe(divisorForm(policy, space));
    expect(lineBound(space)).toBe(8);
    expect(capacityAt(space, policy)).toEqual({ max: 8, exact: true });
  });

  /**
   * The one uniform shape that DOES move, and why that is the fix rather than a
   * regression: a motion-only brief with two kinds and two durations was bounded
   * at 8 by the divisor, and 16 points can be seated. 8 was never a number that
   * was right, so leaving it alone would have left `lineBound` un-bounded on a
   * brief that has nothing to do with `motionRatios` — the defect #499 reported
   * is narrower than the defect that is actually here.
   */
  test("a motion brief whose block spans two axes moves, because its old number was not a bound", () => {
    const policy = policyOf(
      {
        variation: {
          count: 2,
          minDistance: 2,
          axes: { motion: ["ken-burns-in", "ken-burns-out"], duration: [4, 6] },
        },
        output: { formats: ["motion"], platforms: ["instagram-reel"] },
      },
      reelOnly,
    );
    const space = enumerateAxes(policy);
    const exact = capacityAt(space, policy);
    expect(exact.exact).toBe(true);
    expect(divisorForm(policy, space)).toBeLessThan(exact.max);
    // Tight here: the bound is exactly what the space holds.
    expect(lineBound(space)).toBe(exact.max);
  });
});
