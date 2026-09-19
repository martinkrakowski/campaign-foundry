import { describe, test, expect } from "vitest";
import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";
import {
  VariationPolicy,
  type PlanInput,
} from "../../../domain/value-objects/VariationPolicy.vo.js";
import { nodeCryptoPolicyHasher } from "../../../infrastructure/index.js";
import {
  EXACT_CAPACITY_MAX_SPACE,
  EXACT_CAPACITY_STEP_LIMIT,
  InexactCapacityError,
  capacityAt,
  enumerateAxes,
  exactCapacityAt,
  lineBound,
  shortfallMessage,
} from "../PlanCapacity.js";

/**
 * `capacityAt` reports `{ max, exact }`, and when `exact` is false the number it
 * reports is not an arbitrary approximation — it is `lineBound(space)` itself.
 *
 * That makes the signal's own shape the defect. A test that wants the exact
 * maximum in order to CHECK the bound against it receives the bound, compares it
 * with itself and passes. #502 met this: its 56-point mixed space exhausts the
 * production step budget, so `capacityAt(space, policy)` returns the bound, and
 * `expect(lineBound(space)).toBeGreaterThanOrEqual(reported.max)` would have read
 * 28 >= 28. It only escaped by passing an explicit 5,000,000-step budget — a
 * precaution nothing enforced, taken by a lane that happened to look.
 *
 * `exactCapacityAt` is the enforcement: same computation, opposite failure mode.
 * It never substitutes the bound; it throws `InexactCapacityError` naming which
 * limit was hit. `capacityAt` is untouched, because `shortfallMessage` has to name
 * a ceiling for a real operator brief and a loose ceiling beats a thrown error
 * there — the degradation is correct in production and wrong in an oracle, and
 * those are now two functions instead of one flag.
 */

const brief = (over: Record<string, unknown> = {}): CampaignBrief =>
  ({
    id: "exact",
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

/** #502's own shape: 56 points, under the size limit, over the production step budget. */
const exhausting = () => {
  const policy = policyOf(
    {
      variation: {
        count: 2,
        minDistance: 2,
        axes: { motion: ["ken-burns-in", "ken-burns-out"], duration: [4, 6] },
      },
      output: { formats: ["static", "motion"], platforms: ["instagram-reel"] },
    },
    reelOnly,
  );
  return { policy, space: enumerateAxes(policy) };
};

/** Three background sources × three palette shifts on stills: 216 points, past the size limit. */
const oversized = () => {
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
  return { policy, space: enumerateAxes(policy) };
};

/** Motion-only at one reel ratio, one kind, one duration, three palettes: 24 points, closes fast. */
const closes = (minDistance: number) => {
  const policy = policyOf(
    {
      variation: {
        count: 8,
        minDistance,
        axes: { paletteShift: [0, 0.1, 0.2], motion: ["ken-burns-out"], duration: [5] },
      },
      output: { formats: ["motion"], platforms: ["instagram-reel"] },
    },
    reelOnly,
  );
  return { policy, space: enumerateAxes(policy) };
};

/** The one budget measured to close the 56-point space: 137ms, from #502's own note. */
const ORACLE_STEPS = 5_000_000;

describe("an exhausted search hands back the bound, and that is the trap", () => {
  test("the fallback on an exhausting space IS the bound, so bound-covers-max is vacuous", () => {
    const { policy, space } = exhausting();
    // In the regime where the exact branch is attempted: under the size limit.
    expect(space).toHaveLength(56);
    expect(space.length).toBeLessThanOrEqual(EXACT_CAPACITY_MAX_SPACE);

    const bound = lineBound(space);
    expect(bound).toBe(28);

    // What a caller gets without asking for a larger budget.
    const reported = capacityAt(space, policy);
    expect(reported).toEqual({ max: 28, exact: false });
    // And it is not merely close to the bound, it is the bound — identity, not
    // inequality, because `toBeGreaterThanOrEqual` is exactly what it satisfies.
    expect(reported.max).toBe(bound);
    expect(bound).toBeGreaterThanOrEqual(reported.max);

    // The maximum that comparison claimed to have bounded, and never computed.
    // 24 < 28: the assertion above had four variants of slack it never saw.
    expect(exactCapacityAt(space, policy, ORACLE_STEPS)).toBe(24);
    expect(exactCapacityAt(space, policy, ORACLE_STEPS)).toBeLessThan(bound);
  });

  test("asking for an exact capacity on that same space is refused, not answered with the bound", () => {
    const { policy, space } = exhausting();
    let caught: unknown;
    try {
      exactCapacityAt(space, policy);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InexactCapacityError);
    const error = caught as InexactCapacityError;
    // Which limit, not merely that one was hit: a step budget is a cliff a caller
    // can step back from, a size limit is not.
    expect(error.reason).toBe("budget-exhausted");
    expect(error.bound).toBe(28);
    expect(error.spaceSize).toBe(56);
    expect(error.stepLimit).toBe(EXACT_CAPACITY_STEP_LIMIT);
    expect(error.message).toContain("did not close");
    expect(error.message).toContain("against itself");

    // The negative this refusal must NOT be confused with: a function that simply
    // throws. The same call with the budget that closes returns a number, and the
    // number is not the bound.
    expect(() => exactCapacityAt(space, policy, ORACLE_STEPS)).not.toThrow();
    expect(exactCapacityAt(space, policy, ORACLE_STEPS)).toBe(24);
  });
});

describe("the size limit is a different event, and degrades exactly as before", () => {
  test("a space past the size limit still reports the line bound with exact false", () => {
    const { policy, space } = oversized();
    expect(space.length).toBeGreaterThan(EXACT_CAPACITY_MAX_SPACE);
    // Unchanged: this is the legitimate degradation, and it must not become a refusal.
    expect(capacityAt(space, policy)).toEqual({ max: lineBound(space), exact: false });
  });

  test("shortfallMessage on that space still says no more than, and quotes the bound", () => {
    const { policy, space } = oversized();
    const message = shortfallMessage(policy, space, 3);
    expect(message).toContain(`no more than ${lineBound(space)} distinct variants`);
    expect(message).not.toContain("at most");
    expect(message).toContain(`lower count to ${lineBound(space)}`);
    expect(message).toContain(`${space.length} combinations`);
  });

  test("an exact capacity on a space past the size limit is refused for the size, not the budget", () => {
    const { policy, space } = oversized();
    let caught: unknown;
    try {
      // A budget large enough to close a much harder space, to prove the refusal
      // is about the size limit and nothing else.
      exactCapacityAt(space, policy, ORACLE_STEPS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InexactCapacityError);
    const error = caught as InexactCapacityError;
    expect(error.reason).toBe("space-too-large");
    expect(error.bound).toBe(lineBound(space));
    expect(error.spaceSize).toBe(space.length);
    expect(error.stepLimit).toBe(ORACLE_STEPS);
    expect(error.message).toContain("not attempted");
  });
});

describe("where an exact answer exists the two functions are one number", () => {
  test("a space the search closes gives the same maximum both ways", () => {
    const { policy, space } = closes(2);
    const reported = capacityAt(space, policy);
    expect(reported).toEqual({ max: 8, exact: true });
    expect(exactCapacityAt(space, policy)).toBe(reported.max);
    // And here the bound genuinely covers a maximum that was genuinely computed.
    expect(lineBound(space)).toBeGreaterThanOrEqual(exactCapacityAt(space, policy));
  });

  test("at minDistance 1 every point fits and no search runs at all", () => {
    const { policy, space } = closes(1);
    expect(capacityAt(space, policy)).toEqual({ max: space.length, exact: true });
    // Exact by construction, whatever the budget — not even a one-step one refuses.
    expect(exactCapacityAt(space, policy, 1)).toBe(space.length);
  });

  test("shortfallMessage on an exact space says at most, as it always did", () => {
    const { policy, space } = closes(2);
    const message = shortfallMessage(policy, space, 5);
    expect(message).toContain("at most 8 distinct variants");
    expect(message).not.toContain("no more than");
  });
});
