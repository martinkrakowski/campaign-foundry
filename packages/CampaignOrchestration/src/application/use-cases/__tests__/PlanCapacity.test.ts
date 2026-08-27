import { describe, test, expect } from "vitest";
import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";
import { VariationPolicy, type PlanInput } from "../../../domain/value-objects/VariationPolicy.vo.js";
import {
  EXACT_CAPACITY_MAX_SPACE,
  capacityAt,
  conflicts,
  enumerateAxes,
  exhaustiveAccept,
  lineBound,
  matchesNeed,
  maximumIndependentSet,
  shortfallMessage,
  type Axes,
} from "../PlanCapacity.js";

const brief = (over: Record<string, unknown> = {}): CampaignBrief =>
  ({
    id: "tight",
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
  const result = VariationPolicy.fromBrief(brief(over), input);
  if (!result.success) throw result.error;
  return result.value;
};

/** The reported brief: motion-only on a reel, one kind, one duration, three palettes → 24 points. */
const tight = (count: number, minDistance: number) =>
  policyOf(
    {
      variation: {
        count,
        minDistance,
        axes: { paletteShift: [0, 0.1, 0.2], motion: ["ken-burns-out"], duration: [5] },
      },
      output: { formats: ["motion"], platforms: ["instagram-reel"] },
    },
    { motionRatios: ["9:16"] },
  );

const noNeeds = () => [];

describe("enumerateAxes", () => {
  test("a motion-only brief at one ratio enumerates exactly its product space", () => {
    const space = enumerateAxes(tight(8, 2));
    expect(space).toHaveLength(24);
    expect(space.every((axes) => axes.aspectRatio === "9:16" && axes.motion === "ken-burns-out" && axes.durationSec === 5)).toBe(true);
  });

  test("a mixed brief adds one still per base, and non-motion ratios are stills only", () => {
    const policy = policyOf(
      {
        variation: { count: 2, axes: { motion: ["ken-burns-in"], duration: [4] } },
        output: { formats: ["static", "motion"], platforms: ["instagram-feed", "instagram-reel"] },
      },
      { motionRatios: ["9:16"] },
    );
    const space = enumerateAxes(policy);
    const bases = 2 * 2 * 2 * 1 * 1; // products × layout × tone × bg × palette
    // 1:1 and 16:9 → one still each per base; 9:16 → one still + one clip per base
    expect(space).toHaveLength(bases * (1 + 1 + 2));
    expect(space.filter((a) => a.motion !== undefined).every((a) => a.aspectRatio === "9:16")).toBe(true);
  });

  test("a pooled brief carries the headline on every point", () => {
    const policy = policyOf(
      { variation: { count: 2, axes: { headline: "pool://copy" } }, output: { formats: ["static"] } },
      { headlines: ["Stay wild", "Go far"] },
    );
    const space = enumerateAxes(policy);
    expect(space.every((a) => a.headline !== undefined)).toBe(true);
    expect(new Set(space.map((a) => a.headline)).size).toBe(2);
  });
});

describe("conflicts / lineBound", () => {
  test("two points conflict when they differ in fewer than minDistance axes", () => {
    const [a, b] = enumerateAxes(tight(8, 2));
    expect(conflicts(a, a, 1)).toBe(true);
    expect(conflicts(a, b, 2)).toBe(true); // neighbours differ in one axis
    expect(conflicts(a, b, 1)).toBe(false);
  });

  test("the line bound divides the space by its largest axis", () => {
    const policy = tight(8, 2);
    expect(lineBound(enumerateAxes(policy), policy)).toBe(8); // 24 / 3 palettes
  });

  test("in a mixed plan the still slot counts as one more value on the motion axis", () => {
    const mixed = policyOf(
      {
        variation: { count: 2, minDistance: 2, axes: { motion: ["ken-burns-in", "ken-burns-out"], duration: [4, 6] } },
        output: { formats: ["static", "motion"], platforms: ["instagram-reel"] },
      },
      { motionRatios: ["9:16"] },
    );
    const space = enumerateAxes(mixed);
    // motion axis = 2 kinds × 2 durations + 1 still = 5, the largest axis here
    expect(lineBound(space, mixed)).toBe(Math.floor(space.length / 5));
  });
});

describe("maximumIndependentSet", () => {
  test("finds the exact maximum, and reports exhaustion under a tiny step budget", () => {
    // a path a-b-c: maximum independent set is {a, c}
    const adjacency = [0b010n, 0b101n, 0b010n];
    expect(maximumIndependentSet(adjacency, 1_000)).toBe(2);
    expect(maximumIndependentSet(adjacency, 1)).toBeUndefined();
  });
});

describe("capacityAt", () => {
  test("the reported brief holds at most 8 at minDistance 2 — exactly, not by bound", () => {
    const policy = tight(12, 2);
    expect(capacityAt(enumerateAxes(policy), policy)).toEqual({ max: 8, exact: true });
  });

  test("at minDistance 1 every point fits", () => {
    const policy = tight(12, 1);
    expect(capacityAt(enumerateAxes(policy), policy)).toEqual({ max: 24, exact: true });
  });

  test("a space past the exact limit reports the line bound as a bound", () => {
    const policy = policyOf({
      variation: {
        count: 2,
        minDistance: 2,
        axes: { background: { source: ["procedural", "asset-pool", "genai"] }, paletteShift: [0, 0.1, 0.2] },
      },
      output: { formats: ["static"] },
    });
    const space = enumerateAxes(policy);
    expect(space.length).toBeGreaterThan(EXACT_CAPACITY_MAX_SPACE);
    expect(capacityAt(space, policy)).toEqual({ max: lineBound(space, policy), exact: false });
  });

  test("an exhausted search falls back to the bound", () => {
    const policy = tight(12, 2);
    const space = enumerateAxes(policy);
    expect(capacityAt(space, policy, 1)).toEqual({ max: 8, exact: false });
  });
});

describe("matchesNeed", () => {
  const candidate: Axes = enumerateAxes(tight(8, 2))[0];
  test("matches when every fixed axis of the need agrees", () => {
    expect(matchesNeed(candidate, {})).toBe(true);
    expect(matchesNeed(candidate, { productId: candidate.productId })).toBe(true);
    expect(matchesNeed(candidate, { productId: "other" })).toBe(false);
    expect(matchesNeed(candidate, { aspectRatio: "1:1" })).toBe(false);
    expect(matchesNeed(candidate, { productId: candidate.productId, aspectRatio: "9:16" })).toBe(true);
  });
});

describe("exhaustiveAccept", () => {
  test("reaches the capacity of the tight space, pairwise at least minDistance apart", () => {
    const policy = tight(8, 2);
    const chosen = exhaustiveAccept(enumerateAxes(policy), policy, "tight", noNeeds);
    expect(chosen).toHaveLength(8);
    for (const a of chosen) for (const b of chosen) if (a !== b) expect(conflicts(a, b, 2)).toBe(false);
    expect(chosen.map((v) => v.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  test("stops short when the space cannot hold the count", () => {
    const policy = tight(12, 2);
    expect(exhaustiveAccept(enumerateAxes(policy), policy, "tight", noNeeds).length).toBeLessThan(12);
  });

  test("coverage needs rank their candidates first", () => {
    const policy = tight(2, 1);
    // demand beta first: the first pick must be a beta point
    const needs = (accepted: readonly unknown[]) => (accepted.length === 0 ? [{ productId: "beta" }] : []);
    const chosen = exhaustiveAccept(enumerateAxes(policy), policy, "tight", needs);
    expect(chosen[0].productId).toBe("beta");
    expect(chosen).toHaveLength(2);
  });

  test("is deterministic for a brief and seed", () => {
    const policy = tight(8, 2);
    const space = enumerateAxes(policy);
    expect(exhaustiveAccept(space, policy, "tight", noNeeds)).toEqual(exhaustiveAccept(space, policy, "tight", noNeeds));
  });
});

describe("shortfallMessage", () => {
  test("names the exact capacity, the single-ratio reason, and every remedy", () => {
    const policy = tight(12, 2);
    const message = shortfallMessage(policy, enumerateAxes(policy), 7);
    expect(message).toMatch(/accepted 7 of count 12/);
    expect(message).toMatch(/At minDistance 2 this brief can yield at most 8 distinct variants \(24 combinations — every motion platform is 9:16, so the aspect ratio cannot vary\)/);
    expect(message).toMatch(/lower count to 8, lower minDistance \(at 1 the maximum is 24\), add axis values/);
  });

  test("a bounded capacity says 'no more than', a static brief gives no ratio reason, minDistance 1 drops that remedy", () => {
    const large = policyOf({
      variation: {
        count: 2,
        minDistance: 2,
        axes: { background: { source: ["procedural", "asset-pool", "genai"] }, paletteShift: [0, 0.1, 0.2] },
      },
      output: { formats: ["static"] },
    });
    const bounded = shortfallMessage(large, enumerateAxes(large), 1);
    expect(bounded).toMatch(/no more than \d+ distinct variants \(\d+ combinations\)\. To fix/);

    const one = tight(30, 1);
    const flat = shortfallMessage(one, enumerateAxes(one), 24);
    expect(flat).not.toMatch(/lower minDistance/);
    expect(flat).toMatch(/lower count to 24, add axis values/);
  });
});
