import { describe, test, expect } from "vitest";
import { seedFrom } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";
import type { Product } from "../../../domain/entities/Product.js";
import type { Variant } from "../../../domain/entities/Variant.js";
import type { VariationPlan } from "../../../domain/value-objects/VariationPlan.vo.js";
import { MOTION_KINDS } from "../../../domain/value-objects/MotionKind.vo.js";
import { VariationPolicy } from "../../../domain/value-objects/VariationPolicy.vo.js";
import { PlanVariationsUseCase } from "../PlanVariationsUseCase.use-case.js";

const product = (id: string): Product => ({
  id,
  name: id,
  primaryColor: "#1473E6",
  logoPath: `${id}.png`,
});

const brief = (over: Partial<CampaignBrief> = {}): CampaignBrief => ({
  id: "golden",
  targetRegion: "DE",
  targetAudience: "audience",
  campaignMessage: "Hello",
  products: [product("alpha"), product("beta")],
  variation: { count: 12, seed: 7, minDistance: 1 },
  ...over,
});

const planner = (): PlanVariationsUseCase => new PlanVariationsUseCase();

const hamming = (a: Variant, b: Variant): number => {
  const axes = ["productId", "aspectRatio", "layout", "tone", "backgroundSource", "paletteShift", "headline", "motion", "durationSec"] as const;
  return axes.reduce((distance, axis) => distance + (a[axis] !== b[axis] ? 1 : 0), 0);
};

const expectDistanceHeld = (plan: VariationPlan): void => {
  const { variants, policy } = plan;
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      expect(hamming(variants[i], variants[j]), `${i} vs ${j}`).toBeGreaterThanOrEqual(policy.minDistance);
    }
  }
};

describe("PlanVariationsUseCase.plan", () => {
  test("returns the fromBrief error when count is missing", () => {
    const result = planner().plan(brief({ variation: undefined }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/count/);
  });

  test("a fixed two-product brief yields a fixed policyHash and first three variants (golden)", () => {
    const result = planner().plan(brief());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.policyHash).toBe(
      "7181107a6ce42df96357800416bf26bf89007fd3dbd2b9792aab83323adefcf9",
    );
    expect(result.value.variants.slice(0, 3)).toEqual([
      {
        index: 0,
        seed: 3489002692,
        productId: "alpha",
        aspectRatio: "16:9",
        layout: "headline-top",
        tone: "bold",
        backgroundSource: "procedural",
        paletteShift: 0,
      },
      {
        index: 1,
        seed: 786225775,
        productId: "beta",
        aspectRatio: "1:1",
        layout: "headline-bottom",
        tone: "bold",
        backgroundSource: "procedural",
        paletteShift: 0,
      },
      {
        index: 2,
        seed: 767764730,
        productId: "alpha",
        aspectRatio: "9:16",
        layout: "headline-top",
        tone: "subtle",
        backgroundSource: "procedural",
        paletteShift: 0,
      },
    ]);
  });

  test("the same brief twice yields deep-equal plans", () => {
    const input = brief();
    const a = planner().plan(input);
    const b = planner().plan(input);
    expect(a.success && b.success).toBe(true);
    if (a.success && b.success) expect(a.value).toEqual(b.value);
  });

  test("minDistance 2 accepts strictly fewer or equal variants than minDistance 1", () => {
    const loose = planner().plan(brief({ variation: { count: 6, seed: 7, minDistance: 1 } }));
    const tight = planner().plan(brief({ variation: { count: 6, seed: 7, minDistance: 2 } }));
    expect(loose.success && tight.success).toBe(true);
    if (loose.success && tight.success) {
      expect(tight.value.variants.length).toBeLessThanOrEqual(loose.value.variants.length);
      expectDistanceHeld(tight.value);
    }
  });

  test("undersized axis product fails naming count and axisProductSize", () => {
    const result = planner().plan(
      brief({
        products: [product("solo")],
        variation: {
          count: 5,
          seed: 1,
          axes: { layout: ["headline-top"], tone: ["bold"], paletteShift: [0] },
        },
      }),
    );
    // 1 product × 3 ratios × 1 × 1 × 1 × 1 = 3 < 5
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/count 5/);
      expect(result.error.message).toMatch(/axisProductSize 3/);
    }
  });

  test("unreachable count under high minDistance fails with the shortfall", () => {
    const result = planner().plan(brief({ variation: { count: 12, seed: 7, minDistance: 6 } }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/accepted/);
      expect(result.error.message).toMatch(/count 12/);
      expect(result.error.message).toMatch(/axisProductSize 24/);
      expect(result.error.message).toMatch(/minDistance 6/);
    }
  });

  test("coverage minimums are respected for perProduct and perRatio", () => {
    const result = planner().plan(
      brief({
        variation: { count: 12, seed: 7, minDistance: 1, coverage: { perProduct: 2, perRatio: 1 } },
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const byProduct = new Map<string, number>();
    const byRatio = new Map<string, number>();
    for (const variant of result.value.variants) {
      byProduct.set(variant.productId, (byProduct.get(variant.productId) ?? 0) + 1);
      byRatio.set(variant.aspectRatio, (byRatio.get(variant.aspectRatio) ?? 0) + 1);
    }
    expect(byProduct.get("alpha") ?? 0).toBeGreaterThanOrEqual(2);
    expect(byProduct.get("beta") ?? 0).toBeGreaterThanOrEqual(2);
    expect(byRatio.get("1:1") ?? 0).toBeGreaterThanOrEqual(1);
    expect(byRatio.get("9:16") ?? 0).toBeGreaterThanOrEqual(1);
    expect(byRatio.get("16:9") ?? 0).toBeGreaterThanOrEqual(1);
  });

  test("count below perRatio × ratios fails up front", () => {
    const result = planner().plan(brief({ variation: { count: 1, coverage: { perRatio: 1 } } }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/perRatio 1/);
      expect(result.error.message).toMatch(/3 ratios/);
      expect(result.error.message).toMatch(/count 1/);
    }
  });

  test("count below perProduct × products fails up front", () => {
    const result = planner().plan(brief({ variation: { count: 1, coverage: { perProduct: 1 } } }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/perProduct 1/);
      expect(result.error.message).toMatch(/2 products/);
      expect(result.error.message).toMatch(/count 1/);
    }
  });

  test("count 6 perRatio 2 accepts at least two of every ratio", () => {
    const result = planner().plan(
      brief({ variation: { count: 6, seed: 7, minDistance: 1, coverage: { perRatio: 2 } } }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const byRatio = new Map<string, number>();
    for (const variant of result.value.variants) {
      byRatio.set(variant.aspectRatio, (byRatio.get(variant.aspectRatio) ?? 0) + 1);
    }
    expect(byRatio.get("1:1") ?? 0).toBeGreaterThanOrEqual(2);
    expect(byRatio.get("9:16") ?? 0).toBeGreaterThanOrEqual(2);
    expect(byRatio.get("16:9") ?? 0).toBeGreaterThanOrEqual(2);
    expectDistanceHeld(result.value);
  });

  test("returns the first unmet product when the accepted set misses coverage", () => {
    const result = planner().plan(
      brief({
        products: [product("a"), product("b"), product("c"), product("d")],
        variation: { count: 4, seed: 1, minDistance: 1, coverage: { perProduct: 1, perRatio: 1 } },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/coverage unmet/);
      expect(result.error.message).toMatch(/product "b"/);
      expect(result.error.message).toMatch(/perProduct 1/);
    }
  });

  test("returns the first unmet ratio when products meet coverage but a ratio does not", () => {
    const result = planner().plan(
      brief({
        products: [product("a"), product("b"), product("c")],
        variation: { count: 3, seed: 1, minDistance: 1, coverage: { perProduct: 1, perRatio: 1 } },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/coverage unmet/);
      expect(result.error.message).toMatch(/ratio "1:1"/);
      expect(result.error.message).toMatch(/perRatio 1/);
    }
  });

  test("a coverage candidate rejected by distance is retried", () => {
    const result = planner().plan(
      brief({
        products: [product("solo")],
        variation: {
          count: 3,
          seed: 7,
          minDistance: 2,
          coverage: { perRatio: 1 },
          axes: { layout: ["headline-top", "headline-bottom"], tone: ["bold", "subtle"] },
        },
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const byRatio = new Map<string, number>();
    for (const variant of result.value.variants) {
      byRatio.set(variant.aspectRatio, (byRatio.get(variant.aspectRatio) ?? 0) + 1);
    }
    expect(byRatio.get("1:1") ?? 0).toBeGreaterThanOrEqual(1);
    expect(byRatio.get("9:16") ?? 0).toBeGreaterThanOrEqual(1);
    expect(byRatio.get("16:9") ?? 0).toBeGreaterThanOrEqual(1);
    expectDistanceHeld(result.value);
  });

  test("estimate counts genai background variants", () => {
    const result = planner().plan(
      brief({
        variation: {
          count: 4,
          seed: 7,
          minDistance: 1,
          axes: { background: { source: ["genai"] } },
        },
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.estimate.genaiCalls).toBe(4);
    expect(result.value.estimate.feasible).toBe(true);
    expect(result.value.estimate.axisProductSize).toBe(24);
    expect(result.value.briefId).toBe("golden");
  });

  test("each accepted variant seed is seedFrom(briefId, index, 0)", () => {
    const result = planner().plan(brief({ variation: { count: 3, seed: 7 } }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    for (const variant of result.value.variants) {
      expect(variant.seed).toBe(seedFrom("golden", String(variant.index), "0"));
      expect(variant.index).toBe(result.value.variants.indexOf(variant));
    }
  });
});

describe("PlanVariationsUseCase.replan", () => {
  test("replaces only the target slot and keeps distance versus the others", () => {
    const planned = planner().plan(brief());
    expect(planned.success).toBe(true);
    if (!planned.success) return;
    const result = planner().replan(planned.value, 2, 1);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.policyHash).toBe(planned.value.policyHash);
    expect(result.value.seed).toBe(planned.value.seed);
    expect(result.value.policy).toBe(planned.value.policy);
    expect(result.value.variants).toHaveLength(planned.value.variants.length);
    for (let i = 0; i < planned.value.variants.length; i++) {
      if (i === 2) continue;
      expect(result.value.variants[i]).toEqual(planned.value.variants[i]);
    }
    const original = planned.value.variants[2];
    const replacement = result.value.variants[2];
    expect(replacement.index).toBe(2);
    expect(replacement.seed).toBe(seedFrom("golden", "2", "1"));
    expect(replacement.productId).toBe(original.productId);
    expect(replacement.aspectRatio).toBe(original.aspectRatio);
    expect(replacement).not.toEqual(original);
    for (const other of result.value.variants.filter((_, i) => i !== 2)) {
      expect(hamming(replacement, other)).toBeGreaterThanOrEqual(planned.value.policy.minDistance);
    }
    expect(result.value.estimate.genaiCalls).toBe(
      result.value.variants.filter((variant) => variant.backgroundSource === "genai").length,
    );
  });

  test("rejects an invalid index", () => {
    const planned = planner().plan(brief({ variation: { count: 3, seed: 7 } }));
    expect(planned.success).toBe(true);
    if (!planned.success) return;
    const outOfRange = planner().replan(planned.value, 3, 1);
    expect(outOfRange.success).toBe(false);
    if (!outOfRange.success) expect(outOfRange.error.message).toMatch(/index 3/);
    const negative = planner().replan(planned.value, -1, 1);
    expect(negative.success).toBe(false);
    const fractional = planner().replan(planned.value, 1.5, 1);
    expect(fractional.success).toBe(false);
  });

  test("rejects attempt < 1 so a re-roll cannot reuse the original seed", () => {
    const planned = planner().plan(brief({ variation: { count: 3, seed: 7 } }));
    expect(planned.success).toBe(true);
    if (!planned.success) return;
    const zero = planner().replan(planned.value, 0, 0);
    expect(zero.success).toBe(false);
    if (!zero.success) expect(zero.error.message).toMatch(/attempt must be an integer >= 1/);
    const negative = planner().replan(planned.value, 0, -1);
    expect(negative.success).toBe(false);
    const fractional = planner().replan(planned.value, 0, 1.5);
    expect(fractional.success).toBe(false);
  });

  test("re-rolling slot k never changes productId or aspectRatio", () => {
    const planned = planner().plan(brief());
    expect(planned.success).toBe(true);
    if (!planned.success) return;
    for (let k = 0; k < planned.value.variants.length; k++) {
      const result = planner().replan(planned.value, k, 1);
      expect(result.success).toBe(true);
      if (!result.success) return;
      const original = planned.value.variants[k];
      const next = result.value.variants[k];
      expect(next.productId).toBe(original.productId);
      expect(next.aspectRatio).toBe(original.aspectRatio);
      expect(next.index).toBe(k);
    }
  });

  test("exhausts after 64 distance-failing draws", () => {
    const policyResult = VariationPolicy.fromBrief(
      brief({ variation: { count: 2, seed: 7, minDistance: 6 } }),
    );
    expect(policyResult.success).toBe(true);
    if (!policyResult.success) return;
    const occupant: Variant = {
      index: 1,
      seed: 1,
      productId: "alpha",
      aspectRatio: "1:1",
      layout: "headline-bottom",
      tone: "bold",
      backgroundSource: "procedural",
      paletteShift: 0,
    };
    const plan: VariationPlan = {
      policyHash: policyResult.value.policyHash,
      seed: policyResult.value.seed,
      variants: [
        { ...occupant, index: 0, seed: 0 },
        occupant,
      ],
      estimate: {
        creatives: 2,
        axisProductSize: policyResult.value.axisProductSize,
        feasible: true,
        genaiCalls: 0,
      },
      policy: policyResult.value,
      briefId: "golden",
    };
    const result = planner().replan(plan, 0, 1);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/exhausted 64 draws/);
      expect(result.error.message).toMatch(/index 0/);
    }
  });

  test("replan of a product at the perProduct floor never changes productId", () => {
    const policyResult = VariationPolicy.fromBrief(
      brief({ variation: { count: 2, seed: 7, minDistance: 1, coverage: { perProduct: 1 } } }),
    );
    expect(policyResult.success).toBe(true);
    if (!policyResult.success) return;
    const alpha: Variant = {
      index: 0,
      seed: seedFrom("golden", "0", "0"),
      productId: "alpha",
      aspectRatio: "1:1",
      layout: "headline-top",
      tone: "bold",
      backgroundSource: "procedural",
      paletteShift: 0,
    };
    const beta: Variant = {
      index: 1,
      seed: seedFrom("golden", "1", "0"),
      productId: "beta",
      aspectRatio: "9:16",
      layout: "headline-bottom",
      tone: "subtle",
      backgroundSource: "procedural",
      paletteShift: 0,
    };
    const plan: VariationPlan = {
      policyHash: policyResult.value.policyHash,
      seed: policyResult.value.seed,
      variants: [alpha, beta],
      estimate: {
        creatives: 2,
        axisProductSize: policyResult.value.axisProductSize,
        feasible: true,
        genaiCalls: 0,
      },
      policy: policyResult.value,
      briefId: "golden",
    };
    for (let attempt = 1; attempt <= 8; attempt++) {
      const result = planner().replan(plan, 0, attempt);
      if (!result.success) continue;
      expect(result.value.variants[0].productId).toBe("alpha");
      expect(result.value.variants[0].aspectRatio).toBe("1:1");
      expect(result.value.variants[1]).toEqual(beta);
    }
    const any = planner().replan(plan, 0, 1);
    expect(any.success).toBe(true);
    if (any.success) expect(any.value.variants[0].productId).toBe("alpha");
  });

  test("replan still post-checks coverage and exhausts when the occupant cannot satisfy it", () => {
    const policyResult = VariationPolicy.fromBrief(
      brief({ variation: { count: 2, seed: 7, minDistance: 0, coverage: { perProduct: 1 } } }),
    );
    expect(policyResult.success).toBe(true);
    if (!policyResult.success) return;
    const onlyAlpha = (index: number): Variant => ({
      index,
      seed: index,
      productId: "alpha",
      aspectRatio: "1:1",
      layout: "headline-top",
      tone: "bold",
      backgroundSource: "procedural",
      paletteShift: 0,
    });
    const plan: VariationPlan = {
      policyHash: policyResult.value.policyHash,
      seed: policyResult.value.seed,
      variants: [onlyAlpha(0), onlyAlpha(1)],
      estimate: {
        creatives: 2,
        axisProductSize: policyResult.value.axisProductSize,
        feasible: true,
        genaiCalls: 0,
      },
      policy: policyResult.value,
      briefId: "golden",
    };
    const result = planner().replan(plan, 0, 1);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/exhausted 64 draws/);
  });
});

const motionBrief = (over: Partial<CampaignBrief> = {}): CampaignBrief =>
  brief({
    variation: {
      count: 12,
      seed: 7,
      minDistance: 1,
      axes: { motion: ["ken-burns-in", "headline-rise"], duration: [4, 6] },
    },
    output: { formats: ["static", "motion"] },
    ...over,
  });

describe("PlanVariationsUseCase — motion axes", () => {
  test("a mixed-format brief draws both still and motion slots, duration only on motion", () => {
    const result = planner().plan(motionBrief());
    expect(result.success).toBe(true);
    if (!result.success) return;
    const motion = result.value.variants.filter((v) => v.motion !== undefined);
    const still = result.value.variants.filter((v) => v.motion === undefined);
    expect(motion.length).toBeGreaterThan(0);
    expect(still.length).toBeGreaterThan(0);
    for (const v of motion) {
      expect(["ken-burns-in", "headline-rise"]).toContain(v.motion);
      expect([4, 6]).toContain(v.durationSec);
    }
    for (const v of still) expect(v).not.toHaveProperty("durationSec");
    // base × (|motion| × |duration| + one still slot) — the still is not multiplied by |duration|.
    expect(result.value.policy.axisProductSize).toBe(2 * 3 * 2 * 2 * 1 * 1 * (2 * 2 + 1));
    expect(result.value.estimate.frames).toBe(motion.reduce((n, v) => n + (v.durationSec ?? 0) * 30, 0));
    const golden = planner().plan(brief());
    if (golden.success) expect(result.value.policyHash).not.toBe(golden.value.policyHash);
  });

  test("formats [motion] only makes every variant a motion variant", () => {
    const result = planner().plan(motionBrief({ output: { formats: ["motion"] } }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.variants.every((v) => v.motion !== undefined && v.durationSec !== undefined)).toBe(true);
    expect(result.value.policy.mixStatic).toBe(false);
  });

  test("a motion axis without the motion format stays static (no draws, no frames)", () => {
    const golden = planner().plan(brief());
    const noFormat = planner().plan(motionBrief({ output: { formats: ["static"] } }));
    expect(golden.success && noFormat.success).toBe(true);
    if (!golden.success || !noFormat.success) return;
    expect(noFormat.value.variants).toEqual(golden.value.variants);
    expect(noFormat.value.policyHash).toBe(golden.value.policyHash);
    expect(noFormat.value.estimate).not.toHaveProperty("frames");
    expect(noFormat.value.policy.motionEnabled).toBe(false);
  });

  test("formats: motion with an empty motion axis is refused; with no axis every kind is drawn", () => {
    const emptyAxis = planner().plan(
      motionBrief({ variation: { count: 12, seed: 7, minDistance: 1, axes: { motion: [] } } }),
    );
    expect(emptyAxis.success).toBe(false);
    if (!emptyAxis.success) expect(emptyAxis.error.message).toMatch(/select at least one motion kind/);

    const noAxis = planner().plan(
      motionBrief({ variation: { count: 12, seed: 7, minDistance: 1 }, output: { formats: ["motion"] } }),
    );
    expect(noAxis.success).toBe(true);
    if (!noAxis.success) return;
    expect(noAxis.value.variants.every((v) => v.motion !== undefined)).toBe(true);
    expect(noAxis.value.policy.motion).toEqual([...MOTION_KINDS]);
  });

  test("motion and durationSec are Hamming axes (minDistance up to 8)", () => {
    const eight = planner().plan(motionBrief({ variation: { count: 1, seed: 7, minDistance: 8, axes: { motion: ["ken-burns-in"] } } }));
    expect(eight.success).toBe(true);
    const nine = planner().plan(motionBrief({ variation: { count: 1, seed: 7, minDistance: 9 } }));
    expect(nine.success).toBe(false);
    if (!nine.success) expect(nine.error.message).toMatch(/minDistance/);
  });

  test("draws motion only for the ratios in input.motionRatios (the requested motion platforms)", () => {
    const result = planner().plan(
      motionBrief({
        variation: { count: 12, seed: 7, minDistance: 1, axes: { motion: ["ken-burns-in"], duration: [4] } },
        output: { formats: ["static", "motion"], platforms: ["instagram-feed", "instagram-reel", "myspace"] },
      }),
      { motionRatios: ["9:16"] },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.policy.motionRatios).toEqual(["9:16"]);
    const clips = result.value.variants.filter((v) => v.motion !== undefined);
    expect(clips.length).toBeGreaterThan(0);
    expect(clips.every((v) => v.aspectRatio === "9:16")).toBe(true);
    expect(result.value.estimate.frames).toBe(clips.length * 4 * 30);

    // Every requested platform is static: no ratio can ship a clip. A motion-only brief
    // here used to plan every slot as a still the brief never asked for — it is refused.
    const staticOnly = planner().plan(
      motionBrief({ output: { formats: ["motion"], platforms: ["instagram-feed"] } }),
      { motionRatios: [] },
    );
    expect(staticOnly.success).toBe(false);
    if (!staticOnly.success) {
      expect(staticOnly.error.message).toMatch(/requests only "motion" but none of output\.platforms package it/);
    }
  });

  test("a motion-only brief on a motion platform plans clips at every slot — the reported bug", () => {
    // formats [motion] + platforms [instagram-reel] used to draw 16:9 and 1:1 slots that
    // could not be motion and "stayed stills". The ratio axis now narrows to motionRatios.
    const planned = planner().plan(
      motionBrief({ output: { formats: ["motion"], platforms: ["instagram-reel"] } }),
      { motionRatios: ["9:16"] },
    );
    expect(planned.success).toBe(true);
    if (!planned.success) return;
    expect(planned.value.policy.ratios).toEqual(["9:16"]);
    expect(planned.value.variants.length).toBeGreaterThan(0);
    expect(planned.value.variants.every((v) => v.aspectRatio === "9:16" && v.motion !== undefined)).toBe(true);
    // and a replan cannot leave the motion ratios either
    const next = planner().replan(planned.value, 0, 1);
    expect(next.success).toBe(true);
    if (next.success) {
      expect(next.value.variants[0].aspectRatio).toBe("9:16");
      expect(next.value.variants[0].motion).toBeDefined();
    }
  });

  test("in a mixed plan, replan of a ratio no motion platform packages stays a still", () => {
    // The static format is requested too, so a non-motion ratio is a legitimate still.
    const planned = planner().plan(
      motionBrief({
        variation: { count: 12, seed: 7, minDistance: 1, axes: { motion: ["ken-burns-in"], duration: [4] } },
        output: { formats: ["static", "motion"], platforms: ["instagram-feed", "instagram-reel"] },
      }),
      { motionRatios: ["9:16"] },
    );
    expect(planned.success).toBe(true);
    if (!planned.success) return;
    const index = planned.value.variants.findIndex((v) => v.aspectRatio !== "9:16");
    expect(index).toBeGreaterThanOrEqual(0);
    const next = planner().replan(planned.value, index, 1);
    expect(next.success).toBe(true);
    if (next.success) expect(next.value.variants[index].motion).toBeUndefined();
  });

  test("a brief with both the headline and motion axes draws both and bounds minDistance at 9", () => {
    const headlines = ["Stay wild", "Go far"];
    const both = motionBrief({
      variation: {
        count: 12,
        seed: 7,
        minDistance: 1,
        axes: { motion: ["ken-burns-in"], duration: [4], headline: "pool://copy" },
      },
      output: { formats: ["motion"] },
    });
    const result = planner().plan(both, { headlines });
    expect(result.success).toBe(true);
    if (!result.success) return;
    for (const v of result.value.variants) {
      expect(headlines).toContain(v.headline);
      expect(v.motion).toBe("ken-burns-in");
    }
    expect(result.value.policy.axisProductSize).toBe(2 * 3 * 2 * 2 * 1 * 1 * 2 * 1 * 1);
    const nine = planner().plan(
      { ...both, variation: { ...both.variation, count: 1, minDistance: 9 } },
      { headlines },
    );
    expect(nine.success).toBe(true);
    const ten = planner().plan(
      { ...both, variation: { ...both.variation, count: 1, minDistance: 10 } },
      { headlines },
    );
    expect(ten.success).toBe(false);
  });

  test("replan keeps the frames estimate in step with the re-drawn slot", () => {
    const planned = planner().plan(motionBrief());
    expect(planned.success).toBe(true);
    if (!planned.success) return;
    const index = planned.value.variants.findIndex((v) => v.motion !== undefined);
    const next = planner().replan(planned.value, index, 1);
    expect(next.success).toBe(true);
    if (!next.success) return;
    const frames = next.value.variants.reduce((n, v) => n + (v.durationSec ?? 0) * 30, 0);
    expect(next.value.estimate.frames).toBe(frames);
  });

  test("rejects unknown motion kinds and out-of-range durations", () => {
    const badKind = planner().plan(
      motionBrief({ variation: { count: 2, axes: { motion: ["spin"] } } }),
    );
    expect(badKind.success).toBe(false);
    if (!badKind.success) expect(badKind.error.message).toBe("Invalid motion.");
    for (const duration of [1, 31, 2.5]) {
      const bad = planner().plan(motionBrief({ variation: { count: 2, axes: { motion: ["accent-wipe"], duration: [duration] } } }));
      expect(bad.success).toBe(false);
      if (!bad.success) expect(bad.error.message).toBe("Invalid duration.");
    }
  });
});

describe("PlanVariationsUseCase headline axis", () => {
  const pooled = (count = 12): CampaignBrief =>
    brief({ variation: { count, seed: 7, minDistance: 1, axes: { headline: "pool://copy" } } });
  const headlines = ["Stay wild", "Go far", "Drink up"];

  test("draws every variant's headline from the approved pool and keeps distance", () => {
    const result = planner().plan(pooled(), { headlines });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.policy.headline).toEqual([...headlines].sort());
    expect(result.value.estimate.axisProductSize).toBe(24 * 3);
    for (const variant of result.value.variants) {
      expect(headlines).toContain(variant.headline);
    }
    expect(new Set(result.value.variants.map((variant) => variant.headline)).size).toBeGreaterThan(1);
    expectDistanceHeld(result.value);
  });

  test("the same approved set in a different pool order yields an identical policyHash and plan", () => {
    const shuffled = [headlines[2], headlines[0], headlines[1]];
    const a = planner().plan(pooled(), { headlines });
    const b = planner().plan(pooled(), { headlines: shuffled });
    expect(a.success && b.success).toBe(true);
    if (!a.success || !b.success) return;
    expect(b.value.policyHash).toBe(a.value.policyHash);
    expect(b.value).toEqual(a.value);
  });

  test("headline alone satisfies minDistance for otherwise identical variants", () => {
    const result = planner().plan(
      brief({
        products: [product("alpha")],
        variation: {
          count: 3,
          seed: 7,
          minDistance: 1,
          coverage: { perRatio: 0 },
          axes: {
            layout: ["headline-top"],
            tone: ["bold"],
            paletteShift: [0],
            headline: "pool://copy",
          },
        },
      }),
      { headlines },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expectDistanceHeld(result.value);
    expect(result.value.estimate.axisProductSize).toBe(1 * 3 * 1 * 1 * 1 * 1 * 3);
  });

  test("fails naming the pool when pool://copy is requested without approved headlines", () => {
    const missing = planner().plan(pooled());
    expect(missing.success).toBe(false);
    if (!missing.success) expect(missing.error.message).toMatch(/briefs\/golden\/pools\.json/);
    const empty = planner().plan(pooled(), { headlines: [] });
    expect(empty.success).toBe(false);
  });

  test("briefs without the axis are byte-identical to the golden with or without headlines supplied", () => {
    const plain = planner().plan(brief());
    const withInput = planner().plan(brief(), { headlines });
    expect(plain.success && withInput.success).toBe(true);
    if (!plain.success || !withInput.success) return;
    expect(withInput.value).toEqual(plain.value);
    expect(plain.value.policyHash).toBe("7181107a6ce42df96357800416bf26bf89007fd3dbd2b9792aab83323adefcf9");
    expect(plain.value.variants.every((variant) => !("headline" in variant))).toBe(true);
  });

  test("replan re-draws the headline from the stored policy", () => {
    const planned = planner().plan(pooled(), { headlines });
    expect(planned.success).toBe(true);
    if (!planned.success) return;
    const result = planner().replan(planned.value, 1, 1);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(headlines).toContain(result.value.variants[1].headline);
    expectDistanceHeld(result.value);
  });
});
