import { describe, test, expect } from "vitest";
import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";
import {
  VariationPolicy,
  type PlanInput,
} from "../../../domain/value-objects/VariationPolicy.vo.js";
import { nodeCryptoPolicyHasher } from "../../../infrastructure/index.js";
import { enumerateAxes } from "../PlanCapacity.js";
import { PlanVariationsUseCase } from "../PlanVariationsUseCase.use-case.js";

/**
 * `axisProductSize` is the ceiling `count` is clamped to, and "give me every
 * combination" is expressed as count-at-maximum — so the ceiling is only
 * meaningful while it equals the number of points `enumerateAxes` actually
 * produces. SG-D7 measured a mixed `static` + `motion` brief reporting **48**
 * against an enumerator that produces **32**: the arithmetic multiplied the
 * motion factor across every requested ratio, while the enumerator draws motion
 * only at the ratios the requested platforms package it for.
 *
 * The enumerator is the truth here, and it is the one thing measured rather than
 * asserted: it is what the planner draws from, so a ceiling above it names slots
 * that do not exist. Every case below compares the ceiling against a **counted**
 * space, so reverting the arithmetic cannot be absorbed by a stale literal.
 */

const brief = (over: Record<string, unknown> = {}): CampaignBrief =>
  ({
    id: "ceiling",
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

/** The reported shape: three ratios requested, motion packaged at exactly one of them. */
const mixedBrief = (count: number) => ({
  variation: { count, minDistance: 1, axes: { motion: ["ken-burns-in"], duration: [4] } },
  output: { formats: ["static", "motion"], platforms: ["instagram-reel"] },
});

const PARTIAL_MOTION: PlanInput = { motionRatios: ["9:16"] };

describe("a mixed static+motion ceiling is the space the enumerator produces", () => {
  test("the reported 48-against-32 brief: the ceiling equals the counted space", () => {
    const policy = policyOf(mixedBrief(4), PARTIAL_MOTION);
    // Three ratios kept (a mixed plan's non-motion ratios are the stills it asked
    // for), motion packaged at one of them.
    expect(policy.ratios).toEqual(["1:1", "9:16", "16:9"]);
    expect(policy.motionRatios).toEqual(["9:16"]);
    expect(policy.mixStatic).toBe(true);

    const space = enumerateAxes(policy);
    expect(policy.axisProductSize).toBe(space.length);
    // The measured numbers, so a regression names itself rather than moving both
    // sides together: 2 products × 2 layouts × 2 tones = 8 base combinations,
    // ×(1 clip + 1 still) at 9:16 and ×1 still at each of 1:1 and 16:9 → 32.
    expect(space).toHaveLength(32);
    expect(policy.axisProductSize).toBe(32);
    // What the old arithmetic claimed — 3 ratios × (1 × 1 + 1) × 8.
    expect(policy.axisProductSize).not.toBe(48);
  });

  test("motion lands only at the packaged ratio; every other ratio is one still", () => {
    const space = enumerateAxes(policyOf(mixedBrief(4), PARTIAL_MOTION));
    const perRatio = new Map<string, number>();
    const motionPerRatio = new Map<string, number>();
    for (const point of space) {
      perRatio.set(point.aspectRatio, (perRatio.get(point.aspectRatio) ?? 0) + 1);
      if (point.motion !== undefined) {
        motionPerRatio.set(point.aspectRatio, (motionPerRatio.get(point.aspectRatio) ?? 0) + 1);
      }
    }
    // 8 base combinations: the packaged ratio doubles them (clip + still), the
    // unpackaged ones carry the 8 stills and nothing more.
    expect([...perRatio.entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ["1:1", 8],
      ["16:9", 8],
      ["9:16", 16],
    ]);
    expect([...motionPerRatio.entries()]).toEqual([["9:16", 8]]);
  });

  test("the ceiling tracks how many of the requested ratios package motion", () => {
    // Widening motionRatios widens the ceiling, by the enumerator both times.
    for (const motionRatios of [["9:16"], ["9:16", "1:1"], ["1:1", "9:16", "16:9"]]) {
      const policy = policyOf(mixedBrief(4), { motionRatios });
      expect(policy.axisProductSize).toBe(enumerateAxes(policy).length);
    }
    expect(policyOf(mixedBrief(4), { motionRatios: ["9:16"] }).axisProductSize).toBe(32);
    expect(policyOf(mixedBrief(4), { motionRatios: ["9:16", "1:1"] }).axisProductSize).toBe(40);
    // Every requested ratio packaged is the one case the old arithmetic got right.
    expect(
      policyOf(mixedBrief(4), { motionRatios: ["1:1", "9:16", "16:9"] }).axisProductSize,
    ).toBe(48);
  });

  test("a wider motion axis is counted per packaged ratio, not per ratio", () => {
    const policy = policyOf(
      {
        variation: {
          count: 4,
          minDistance: 1,
          axes: { motion: ["ken-burns-in", "ken-burns-out"], duration: [4, 6] },
        },
        output: { formats: ["static", "motion"], platforms: ["instagram-reel"] },
      },
      PARTIAL_MOTION,
    );
    const space = enumerateAxes(policy);
    expect(policy.axisProductSize).toBe(space.length);
    // 8 bases × (2 kinds × 2 durations + 1 still) at 9:16, + 8 stills × 2 ratios.
    expect(space).toHaveLength(8 * 5 + 8 + 8);
  });
});

describe("the ceilings that were already right do not move", () => {
  test("a static-only brief's ceiling is unchanged and still equals its space", () => {
    const policy = policyOf({
      variation: { count: 4, minDistance: 1 },
      output: { formats: ["static"], platforms: ["instagram-feed"] },
    });
    expect(policy.motionEnabled).toBe(false);
    expect(policy.axisProductSize).toBe(enumerateAxes(policy).length);
    // 2 products × 3 ratios × 2 layouts × 2 tones — the pre-motion golden.
    expect(policy.axisProductSize).toBe(24);
  });

  test("a motion-only brief's ceiling is unchanged: its ratios are already narrowed", () => {
    const policy = policyOf(
      {
        variation: { count: 4, minDistance: 1, axes: { motion: ["ken-burns-in"], duration: [4] } },
        output: { formats: ["motion"], platforms: ["instagram-reel"] },
      },
      PARTIAL_MOTION,
    );
    expect(policy.mixStatic).toBe(false);
    // The narrowing already dropped every unpackaged ratio, so there is no ratio
    // left that the old arithmetic could have over-counted.
    expect(policy.ratios).toEqual(["9:16"]);
    expect(policy.axisProductSize).toBe(enumerateAxes(policy).length);
    expect(policy.axisProductSize).toBe(8);
  });

  test("a motion-only brief with several kinds and durations is unchanged", () => {
    const policy = policyOf(
      {
        variation: {
          count: 4,
          minDistance: 1,
          axes: { motion: ["ken-burns-in", "ken-burns-out"], duration: [4, 6] },
        },
        output: { formats: ["motion"], platforms: ["instagram-reel"] },
      },
      PARTIAL_MOTION,
    );
    expect(policy.axisProductSize).toBe(enumerateAxes(policy).length);
    // 8 bases × 2 kinds × 2 durations, at the single packaged ratio.
    expect(policy.axisProductSize).toBe(32);
  });
});

describe("count at the ceiling plans, end to end (SG-D7's property, on a mixed brief)", () => {
  const planner = () => new PlanVariationsUseCase(nodeCryptoPolicyHasher);

  test("a mixed brief plans at count = axisProductSize and draws the space exactly once", () => {
    const ceiling = policyOf(mixedBrief(1), PARTIAL_MOTION).axisProductSize;
    expect(ceiling).toBe(32);

    const result = planner().plan(brief(mixedBrief(ceiling)), PARTIAL_MOTION);
    // The whole point of the ceiling: the count the slider's own maximum offers
    // is a count the planner accepts. At 48 this was refused outright.
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.variants).toHaveLength(ceiling);

    // Exactly once: every drawn variant is a distinct point of the space.
    const key = (variant: Record<string, unknown>) =>
      JSON.stringify([
        variant.productId,
        variant.aspectRatio,
        variant.layout,
        variant.tone,
        variant.backgroundSource,
        variant.paletteShift,
        variant.motion ?? null,
        variant.durationSec ?? null,
      ]);
    const drawn = new Set(
      result.value.variants.map((variant) => key(variant as unknown as Record<string, unknown>)),
    );
    expect(drawn.size).toBe(ceiling);
    const space = new Set(
      enumerateAxes(policyOf(mixedBrief(1), PARTIAL_MOTION)).map((axes) =>
        key(axes as unknown as Record<string, unknown>),
      ),
    );
    expect(drawn).toEqual(space);
  });

  test("one past the ceiling is still refused, and the refusal names the real size", () => {
    const result = planner().plan(brief(mixedBrief(33)), PARTIAL_MOTION);
    expect(result.success).toBe(false);
    if (result.success) return;
    // 48 was the old ceiling: a count of 33 was waved through and then failed to
    // fill, so the message naming 32 is the fix visible at the boundary.
    expect(result.error.message).toMatch(/axisProductSize 32/);
  });
});
