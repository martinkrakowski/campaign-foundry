import { describe, test, expect } from "vitest";
import { seedFrom } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";
import type { Product } from "../../../domain/entities/Product.js";
import type { Variant } from "../../../domain/entities/Variant.js";
import type { VariationPlan } from "../../../domain/value-objects/VariationPlan.vo.js";
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
  const axes = ["productId", "aspectRatio", "layout", "tone", "backgroundSource", "paletteShift"] as const;
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
    const replacement = result.value.variants[2];
    expect(replacement.index).toBe(2);
    expect(replacement.seed).toBe(seedFrom("golden", "2", "1"));
    expect(replacement).not.toEqual(planned.value.variants[2]);
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
    const outOfRange = planner().replan(planned.value, 3, 0);
    expect(outOfRange.success).toBe(false);
    if (!outOfRange.success) expect(outOfRange.error.message).toMatch(/index 3/);
    const negative = planner().replan(planned.value, -1, 0);
    expect(negative.success).toBe(false);
    const fractional = planner().replan(planned.value, 1.5, 0);
    expect(fractional.success).toBe(false);
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
    for (let attempt = 0; attempt < 8; attempt++) {
      const result = planner().replan(plan, 0, attempt);
      if (!result.success) continue;
      expect(result.value.variants[0].productId).toBe("alpha");
      expect(result.value.variants[1]).toEqual(beta);
    }
    const any = planner().replan(plan, 0, 1);
    expect(any.success).toBe(true);
    if (any.success) expect(any.value.variants[0].productId).toBe("alpha");
  });
});
