import { describe, test, expect } from "vitest";
import { seedFrom } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";
import { BRIEF_SCHEMA_VERSION } from "../../../domain/value-objects/brief-schema-version.js";
import { DEFAULT_CAMPAIGN_TYPE } from "../../../domain/value-objects/campaign-types.js";
import { templateFromCanonical } from "../../../domain/value-objects/brief-template.js";
import type { Product } from "../../../domain/entities/Product.js";
import type { Variant } from "../../../domain/entities/Variant.js";
import type { VariationPlan } from "../../../domain/value-objects/VariationPlan.vo.js";
import { MOTION_KINDS } from "../../../domain/value-objects/MotionKind.vo.js";
import { hashCopy, VariationPolicy } from "../../../domain/value-objects/VariationPolicy.vo.js";
import { nodeCryptoPolicyHasher } from "../../../infrastructure/index.js";
import { EXHAUSTIVE_MAX_SPACE, enumerateAxes } from "../PlanCapacity.js";
import { PlanVariationsUseCase } from "../PlanVariationsUseCase.use-case.js";

const product = (id: string): Product => ({
  id,
  name: id,
  primaryColor: "#1473E6",
  logoPath: `${id}.png`,
});

const brief = (over: Partial<CampaignBrief> = {}): CampaignBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(over.type ?? DEFAULT_CAMPAIGN_TYPE),
  id: "golden",
  targetRegion: "DE",
  targetAudience: "audience",
  campaignMessage: "Hello",
  products: [product("alpha"), product("beta")],
  variation: { count: 12, seed: 7, minDistance: 1 },
  ...over,
});

const planner = (): PlanVariationsUseCase => new PlanVariationsUseCase(nodeCryptoPolicyHasher);

const hamming = (a: Variant, b: Variant): number => {
  const axes = [
    "productId",
    "aspectRatio",
    "layout",
    "tone",
    "backgroundSource",
    "paletteShift",
    "headline",
    "motion",
    "durationSec",
    "anchor",
  ] as const;
  return axes.reduce((distance, axis) => distance + (a[axis] !== b[axis] ? 1 : 0), 0);
};

const expectDistanceHeld = (plan: VariationPlan): void => {
  const { variants, policy } = plan;
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      expect(hamming(variants[i], variants[j]), `${i} vs ${j}`).toBeGreaterThanOrEqual(
        policy.minDistance,
      );
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

  test("carries a copyHash equal to hashCopy(brief, hasher), independent of policyHash (X33, §35)", () => {
    const input = brief({ campaignMessage: "Stay wild" });
    const result = planner().plan(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.copyHash).toBe(hashCopy(input, nodeCryptoPolicyHasher));

    // An axis-only change moves policyHash but not copyHash. (This was
    // `minDistance: 0`, which SL-D6 now refuses; a palette-shift axis is in any
    // case what the sentence above claims to be testing.)
    const differentAxis = planner().plan({
      ...input,
      variation: { ...input.variation, axes: { paletteShift: [0, 0.1] } },
    });
    expect(differentAxis.success).toBe(true);
    if (differentAxis.success) {
      expect(differentAxis.value.copyHash).toBe(result.value.copyHash);
      expect(differentAxis.value.policyHash).not.toBe(result.value.policyHash);
    }

    // A copy-only change moves copyHash but not policyHash.
    const differentCopy = planner().plan({ ...input, campaignMessage: "Stay tame" });
    expect(differentCopy.success).toBe(true);
    if (differentCopy.success) {
      expect(differentCopy.value.copyHash).not.toBe(result.value.copyHash);
      expect(differentCopy.value.policyHash).toBe(result.value.policyHash);
    }
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
      expect(result.error.message).toMatch(
        /Variation plan shortfall: accepted \d+ of count \d+\. At minDistance \d+ this brief can yield (at most|no more than) \d+ distinct variants \(24 combinations/,
      );
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

  test("estimate.sceneBackgrounds is present (true) only when the brief's timeline names a background (VE5b2)", () => {
    const withScene = planner().plan(
      brief({
        copy: {
          timeline: {
            transition: "cut",
            keyBeat: 1,
            beats: [
              { text: "Alpha", weight: 1, background: "assets/inputs/golden/scene.png" },
              { text: "Beta", weight: 1 },
            ],
          },
        },
      }),
    );
    expect(withScene.success).toBe(true);
    if (withScene.success) expect(withScene.value.estimate.sceneBackgrounds).toBe(true);

    // A brief with no timeline at all, and one whose timeline names no
    // background, both leave the key absent — never `false` — so a
    // scene-free plan's JSON stays byte-identical (VE-D3).
    const noTimeline = planner().plan(brief());
    expect(noTimeline.success).toBe(true);
    if (noTimeline.success) {
      expect("sceneBackgrounds" in noTimeline.value.estimate).toBe(false);
    }

    const timelineNoScenes = planner().plan(
      brief({
        copy: {
          timeline: { transition: "cut", keyBeat: 1, beats: [{ text: "Alpha", weight: 1 }] },
        },
      }),
    );
    expect(timelineNoScenes.success).toBe(true);
    if (timelineNoScenes.success) {
      expect("sceneBackgrounds" in timelineNoScenes.value.estimate).toBe(false);
    }

    // A scene never counts as a genai call (VE5b2/VE-D10): since VE5a a scene
    // is an uploaded asset path, never a generated one.
    if (withScene.success) expect(withScene.value.estimate.genaiCalls).toBe(0);
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

describe("PlanVariationsUseCase — anchor axis", () => {
  test("draws the anchor only when the brief carries it, so axis-less plans stay golden", () => {
    const plain = planner().plan(brief({ variation: { count: 12, seed: 7, minDistance: 1 } }));
    const anchoredBrief = brief({
      variation: { count: 12, seed: 7, minDistance: 1, axes: { anchor: ["middle"] } },
    });
    const anchored = planner().plan(anchoredBrief);
    expect(plain.success && anchored.success).toBe(true);
    if (!plain.success || !anchored.success) return;
    // Without the axis no variant carries an anchor — the draw consumed nothing.
    for (const variant of plain.value.variants) expect(variant.anchor).toBeUndefined();
    // With the axis every slot drew it, and the estimate reflects the axis.
    for (const variant of anchored.value.variants) expect(variant.anchor).toBe("middle");
    expect(anchored.value.estimate.axisProductSize).toBe(plain.value.estimate.axisProductSize * 1);
    expect(anchored.value.policyHash).not.toBe(plain.value.policyHash);
  });

  test("the anchor is a Hamming axis: minDistance 2 is satisfiable across a two-value draw", () => {
    const result = planner().plan(
      brief({
        variation: { count: 6, seed: 7, minDistance: 2, axes: { anchor: ["top", "middle"] } },
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) expectDistanceHeld(result.value);
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
    expect(result.value.copyHash).toBe(planned.value.copyHash);
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
      {},
      nodeCryptoPolicyHasher,
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
      copyHash: "copy-hash",
      seed: policyResult.value.seed,
      variants: [{ ...occupant, index: 0, seed: 0 }, occupant],
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
      {},
      nodeCryptoPolicyHasher,
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
      copyHash: "copy-hash",
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
      brief({ variation: { count: 2, seed: 7, minDistance: 1, coverage: { perProduct: 1 } } }),
      {},
      nodeCryptoPolicyHasher,
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
      copyHash: "copy-hash",
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

  /**
   * SL-D6, the half of the floor that lives on the random-draw path.
   *
   * `meetsMinDistance` is a module-private function reached only through `plan`
   * and `replan`, and `VariationPolicy.fromBrief` now refuses a policy below 1 —
   * so the policy is built at 1 and lowered by hand, which is precisely the case
   * the floor exists for: a distance the search must not honour, however it
   * arrived. The space is deliberately a SINGLE point (one product, one ratio,
   * one value on every treatment axis), so every draw returns the occupant's own
   * combination and Hamming distance is always 0. Coverage is left at its default
   * of zero, so the distance check is the only thing that can refuse a draw —
   * without that, `firstUnmetCoverage` would exhaust the draws for its own
   * reasons and the test would pass on an unfloored `meetsMinDistance` too.
   */
  test("a policy that slipped through at 0 still refuses a replacement at the same point", () => {
    const onePoint = brief({
      variation: {
        count: 1,
        seed: 7,
        minDistance: 1,
        axes: {
          layout: ["headline-top"],
          tone: ["bold"],
          background: { source: ["procedural"] },
          paletteShift: [0],
        },
      },
      products: [product("alpha")],
    });
    const built = VariationPolicy.fromBrief(onePoint, { ratios: ["1:1"] }, nodeCryptoPolicyHasher);
    expect(built.success).toBe(true);
    if (!built.success) return;
    expect(built.value.axisProductSize).toBe(1);
    expect(built.value.coverage).toEqual({ perProduct: 0, perRatio: 0 });
    const slipped: VariationPolicy = { ...built.value, minDistance: 0 };

    const only = (index: number): Variant => ({
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
      policyHash: slipped.policyHash,
      copyHash: "copy-hash",
      seed: slipped.seed,
      variants: [only(0), only(1)],
      estimate: { creatives: 2, axisProductSize: 1, feasible: true, genaiCalls: 0 },
      policy: slipped,
      briefId: "golden",
    };

    // Unfloored, `hamming(candidate, other) >= 0` holds for the identical point,
    // so the very first draw is accepted and `replan` succeeds with a duplicate.
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
    expect(result.value.estimate.frames).toBe(
      motion.reduce((n, v) => n + (v.durationSec ?? 0) * 30, 0),
    );
    const golden = planner().plan(brief());
    if (golden.success) expect(result.value.policyHash).not.toBe(golden.value.policyHash);
  });

  test("formats [motion] only makes every variant a motion variant", () => {
    const result = planner().plan(motionBrief({ output: { formats: ["motion"] } }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(
      result.value.variants.every((v) => v.motion !== undefined && v.durationSec !== undefined),
    ).toBe(true);
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
    if (!emptyAxis.success)
      expect(emptyAxis.error.message).toMatch(/select at least one motion kind/);

    const noAxis = planner().plan(
      motionBrief({
        variation: { count: 12, seed: 7, minDistance: 1 },
        output: { formats: ["motion"] },
      }),
    );
    expect(noAxis.success).toBe(true);
    if (!noAxis.success) return;
    expect(noAxis.value.variants.every((v) => v.motion !== undefined)).toBe(true);
    expect(noAxis.value.policy.motion).toEqual([...MOTION_KINDS]);
  });

  test("motion and durationSec are Hamming axes (minDistance up to 8)", () => {
    const eight = planner().plan(
      motionBrief({
        variation: { count: 1, seed: 7, minDistance: 8, axes: { motion: ["ken-burns-in"] } },
      }),
    );
    expect(eight.success).toBe(true);
    const nine = planner().plan(motionBrief({ variation: { count: 1, seed: 7, minDistance: 9 } }));
    expect(nine.success).toBe(false);
    if (!nine.success) expect(nine.error.message).toMatch(/minDistance/);
  });

  test("draws motion only for the ratios in input.motionRatios (the requested motion platforms)", () => {
    const result = planner().plan(
      motionBrief({
        variation: {
          count: 12,
          seed: 7,
          minDistance: 1,
          axes: { motion: ["ken-burns-in"], duration: [4] },
        },
        output: {
          formats: ["static", "motion"],
          platforms: ["instagram-feed", "instagram-reel", "myspace"],
        },
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
      expect(staticOnly.error.message).toMatch(
        /requests only "motion" but none of output\.platforms package it/,
      );
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
    expect(
      planned.value.variants.every((v) => v.aspectRatio === "9:16" && v.motion !== undefined),
    ).toBe(true);
    // and a replan cannot leave the motion ratios either
    const next = planner().replan(planned.value, 0, 1);
    expect(next.success).toBe(true);
    if (next.success) {
      expect(next.value.variants[0].aspectRatio).toBe("9:16");
      expect(next.value.variants[0].motion).toBeDefined();
    }
  });

  test("a tight motion-only brief plans up to its capacity where the random draw fell short", () => {
    // The reported case: one kind, one duration, three palettes, two products at 9:16
    // → 24 points; at minDistance 2 the exact maximum is 8. The 3 × count random draw
    // accepted 7; the exhaustive search must reach 8.
    const result = planner().plan(
      motionBrief({
        variation: {
          count: 8,
          minDistance: 2,
          axes: { paletteShift: [0, 0.1, 0.2], motion: ["ken-burns-out"], duration: [5] },
        },
        output: { formats: ["motion"], platforms: ["instagram-reel"] },
      }),
      { motionRatios: ["9:16"] },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.variants).toHaveLength(8);
    expect(
      result.value.variants.every((v) => v.aspectRatio === "9:16" && v.motion !== undefined),
    ).toBe(true);
  });

  test("a space too large to search exhaustively still gets an honest bound on shortfall", () => {
    // 2 × 3 × 2 × 2 × 3 backgrounds × 10 palettes × 6 headlines = 4320 points, past the
    // exhaustive limit. At minDistance 7 (every active axis must differ) the product axis
    // caps the set at 2, so the random draw falls short and the bound is reported.
    const result = planner().plan(
      motionBrief({
        variation: {
          count: 12,
          seed: 7,
          minDistance: 7,
          axes: {
            background: { source: ["procedural", "asset-pool", "genai"] },
            paletteShift: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45],
            headline: "pool://copy",
          },
        },
        output: { formats: ["static"] },
      }),
      { headlines: ["a", "b", "c", "d", "e", "f"] },
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(
      /can yield no more than \d+ distinct variants \(4320 combinations\)/,
    );
  });

  test("a count beyond capacity says what the capacity is and how to fix it", () => {
    const result = planner().plan(
      motionBrief({
        variation: {
          count: 12,
          minDistance: 2,
          axes: { paletteShift: [0, 0.1, 0.2], motion: ["ken-burns-out"], duration: [5] },
        },
        output: { formats: ["motion"], platforms: ["instagram-reel"] },
      }),
      { motionRatios: ["9:16"] },
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(
      /can yield at most 8 distinct variants \(24 combinations — every motion platform is 9:16/,
    );
    expect(result.error.message).toMatch(
      /lower count to 8, lower minDistance \(at 1 the maximum is 24\)/,
    );
  });

  test("in a mixed plan, replan of a ratio no motion platform packages stays a still", () => {
    // The static format is requested too, so a non-motion ratio is a legitimate still.
    const planned = planner().plan(
      motionBrief({
        variation: {
          count: 12,
          seed: 7,
          minDistance: 1,
          axes: { motion: ["ken-burns-in"], duration: [4] },
        },
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
      const bad = planner().plan(
        motionBrief({
          variation: { count: 2, axes: { motion: ["accent-wipe"], duration: [duration] } },
        }),
      );
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
    expect(new Set(result.value.variants.map((variant) => variant.headline)).size).toBeGreaterThan(
      1,
    );
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
    expect(plain.value.policyHash).toBe(
      "7181107a6ce42df96357800416bf26bf89007fd3dbd2b9792aab83323adefcf9",
    );
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

/**
 * SG-D7: what `count = axisProductSize` actually means, since the editor clamps the
 * count slider to that ceiling (`editor-state.ts:734`) and SG-D1 retires `mode` on the
 * strength of "count at maximum" meaning *every combination*. `executeVariation`
 * (`GenerateCampaignUseCase.use-case.ts:543`) passes `plan.variants` straight through,
 * so this is the planner's property.
 *
 * The mechanism: `DISTANCE_AXES` names every axis `enumerateAxes` varies, so Hamming 0
 * means *the same point in the space*. At `minDistance >= 1` no duplicate can ever be
 * accepted, so `axisProductSize` accepted variants out of a space of `axisProductSize`
 * is necessarily the whole space exactly once.
 *
 * SL-D6 closes the one hole in that argument: `minDistance 0` used to be settable, and
 * removed the premise. It is now refused by `VariationPolicy.fromBrief`, and floored in
 * both searches besides — see `meetsMinDistance` below and `conflicts` in
 * `PlanCapacity.test.ts` — so `minDistance >= 1` is no longer an assumption.
 */
describe("PlanVariationsUseCase.plan at count = axisProductSize (SG-D7)", () => {
  /** The 24-combination default × five palette shifts: 120 points. */
  const spread = { paletteShift: [0, 0.1, 0.2, 0.3, 0.4] } as const;

  const ceilingBrief = (minDistance: number, count: number): CampaignBrief =>
    brief({ variation: { count, seed: 7, minDistance, axes: { ...spread } } });

  const policyAt = (minDistance: number): VariationPolicy => {
    const result = VariationPolicy.fromBrief(
      ceilingBrief(minDistance, 1),
      {},
      nodeCryptoPolicyHasher,
    );
    if (!result.success) throw result.error;
    return result.value;
  };

  /** The point a variant occupies, over exactly the axes `enumerateAxes` varies. */
  const point = (axes: Partial<Variant>): string =>
    JSON.stringify([
      axes.productId,
      axes.aspectRatio,
      axes.layout,
      axes.tone,
      axes.backgroundSource,
      axes.paletteShift,
      axes.headline,
      axes.anchor,
      axes.motion,
      axes.durationSec,
    ]);

  test("the ceiling is the enumerable space, not a larger number", () => {
    const policy = policyAt(1);
    // 2 products × 3 ratios × 2 layouts × 2 tones × 1 background × 5 palette shifts.
    expect(policy.axisProductSize).toBe(120);
    expect(enumerateAxes(policy)).toHaveLength(policy.axisProductSize);
  });

  test("at the ceiling with minDistance 1 the plan is the whole space, each point exactly once", () => {
    const policy = policyAt(1);
    const space = enumerateAxes(policy);
    const result = planner().plan(ceilingBrief(1, policy.axisProductSize));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { variants } = result.value;
    expect(variants).toHaveLength(space.length);
    // Exactly once, in both directions: as many distinct points as variants, and the
    // set of points drawn is the set of points the space contains. A sample to the
    // same size would repeat a point and so miss another.
    const drawn = new Set(variants.map(point));
    expect(drawn.size).toBe(variants.length);
    expect(drawn).toEqual(new Set(space.map(point)));
  });

  test("minDistance 0 is no longer reachable at the ceiling — the policy refuses it (SL-D6)", () => {
    // This test previously recorded the defect: at 0 `meetsMinDistance` admitted
    // Hamming 0, the draw sampled WITH REPLACEMENT, and "count at maximum" quietly
    // stopped meaning every combination — 83 distinct of 120. SG-D7 handed the owner
    // the choice and the answer was "the minimum should be 1", so the assertion is
    // inverted: the brief is refused rather than silently sampled.
    const policy = policyAt(1);
    expect(policy.axisProductSize).toBe(120);
    const refused = VariationPolicy.fromBrief(
      ceilingBrief(0, policy.axisProductSize),
      {},
      nodeCryptoPolicyHasher,
    );
    expect(refused.success).toBe(false);
    if (!refused.success) expect(refused.error.message).toBe("Invalid minDistance.");
    // …and the planner surfaces that refusal rather than planning at 0.
    const result = planner().plan(ceilingBrief(0, policy.axisProductSize));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/minDistance/);
  });

  test("above EXHAUSTIVE_MAX_SPACE an operator can still ask for a ceiling that cannot enumerate", () => {
    // The enumerate-exactly-once guarantee above rests on the exhaustive search at
    // `PlanVariationsUseCase.use-case.ts:112-116`, which is skipped when the space is
    // larger than `EXHAUSTIVE_MAX_SPACE`. This brief is ordinary editor input — three
    // background sources, ten palette shifts, a six-text copy pool — and clears the
    // limit, and the policy accepts `count` at its ceiling, so `plan` reaches the
    // shortfall branch rather than enumerating. The branch's outcome above the limit
    // is already covered by "a space too large to search exhaustively still gets an
    // honest bound on shortfall" (:780); a run at this ceiling takes ~6s, too slow
    // to commit, and is recorded in the PR body instead.
    const axes = {
      background: { source: ["procedural", "asset-pool", "genai"] },
      paletteShift: [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45],
      headline: "pool://copy",
    };
    const input = { headlines: ["a", "b", "c", "d", "e", "f"] };
    const wide = (count: number): CampaignBrief =>
      brief({
        variation: { count, seed: 7, minDistance: 1, axes },
        output: { formats: ["static"] },
      });
    const sized = VariationPolicy.fromBrief(wide(1), input, nodeCryptoPolicyHasher);
    expect(sized.success).toBe(true);
    if (!sized.success) return;
    expect(enumerateAxes(sized.value)).toHaveLength(sized.value.axisProductSize);
    expect(sized.value.axisProductSize).toBeGreaterThan(EXHAUSTIVE_MAX_SPACE);
    const atCeiling = VariationPolicy.fromBrief(
      wide(sized.value.axisProductSize),
      input,
      nodeCryptoPolicyHasher,
    );
    expect(atCeiling.success).toBe(true);
    if (!atCeiling.success) return;
    expect(atCeiling.value.count).toBe(sized.value.axisProductSize);
  });
});

/**
 * SL2 — slots are monotonic and a deleted one is never reissued (SL-D3/SL-D4/SL-D5).
 *
 * The property every test here serves is §7's first line: **deleting one creative
 * leaves the others byte-identical**. That is asserted on the whole `Variant` —
 * `toEqual` over the surviving objects — and deliberately not on seeds and asset
 * keys alone. Seeds are derived from the index, so they survive any allocation
 * scheme that keeps the index, including the wrong one; and the key
 * `${productId}/v${index}` can match by luck when a coverage need pins the
 * product. The axes are what a wrong scheme moves, and the axes are what a
 * screenshot would have shown.
 */
const occupancyBrief = (
  occupancy: Record<string, unknown> | undefined,
  over: Record<string, unknown> = {},
): CampaignBrief =>
  brief({
    variation: {
      count: 12,
      seed: 7,
      minDistance: 1,
      ...(occupancy === undefined ? {} : { occupancy }),
      ...over,
    },
  } as Partial<CampaignBrief>);

/**
 * The reported tight case: one kind, one duration, three palettes, 9:16 → 24
 * points, capacity exactly 8 at minDistance 2.
 *
 * The seed is a parameter because whether the 3 × allocated **random** draw
 * reaches that capacity depends on it, and the two facts this file needs are on
 * opposite sides of that line — measured, not assumed:
 *
 * - `seed: 7` — the random draw reaches 8 on its own. An append of an eighth
 *   creative to seven therefore goes through the draw, which is the path that
 *   distances a new candidate against the occupants.
 * - `"derived"`, the brief's own seed with no `seed` key — the random draw stops
 *   at 7, so a plan of 8 exists only through `exhaustiveAccept`. That is the
 *   case a delete must not strand. (Spelled as a word, not `undefined`: an
 *   explicit `undefined` argument takes a parameter's default, so the two
 *   fixtures would silently be one.)
 */
const tightBrief = (
  count: number,
  occupancy?: Record<string, unknown>,
  seed: number | "derived" = 7,
): CampaignBrief =>
  motionBrief({
    variation: {
      count,
      ...(seed === "derived" ? {} : { seed }),
      minDistance: 2,
      axes: { paletteShift: [0, 0.1, 0.2], motion: ["ken-burns-out"], duration: [5] },
      ...(occupancy === undefined ? {} : { occupancy }),
    },
    output: { formats: ["motion"], platforms: ["instagram-reel"] },
  } as Partial<CampaignBrief>);

const tightInput = { motionRatios: ["9:16"] } as const;

describe("PlanVariationsUseCase.plan — monotonic slots (SL2)", () => {
  test("a brief carrying no occupancy plans exactly what it planned before", () => {
    const withoutBlock = planner().plan(occupancyBrief(undefined));
    const trivialBlock = planner().plan(occupancyBrief({ nextIndex: 12 }));
    const emptyTombstones = planner().plan(occupancyBrief({ nextIndex: 12, tombstoned: [] }));
    expect(withoutBlock.success).toBe(true);
    expect(trivialBlock.success).toBe(true);
    expect(emptyTombstones.success).toBe(true);
    if (!withoutBlock.success || !trivialBlock.success || !emptyTombstones.success) return;
    expect(withoutBlock.value.variants).toHaveLength(12);
    expect(withoutBlock.value.variants.map((v) => v.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(trivialBlock.value.variants).toEqual(withoutBlock.value.variants);
    expect(emptyTombstones.value.variants).toEqual(withoutBlock.value.variants);
  });

  test("deleting a slot leaves every other creative byte-identical — axes, seed and index", () => {
    const before = planner().plan(occupancyBrief(undefined));
    const after = planner().plan(occupancyBrief({ nextIndex: 12, tombstoned: [2] }));
    expect(before.success).toBe(true);
    expect(after.success).toBe(true);
    if (!before.success || !after.success) return;

    const survivors = before.value.variants.filter((variant) => variant.index !== 2);
    // The whole object, not a summary of it: this is the assertion the rejected
    // coordinate design and a compacting reallocation both fail.
    expect(after.value.variants).toEqual(survivors);
    expect(after.value.variants).toHaveLength(11);
    // And the two surrogates the definition of done names explicitly.
    expect(after.value.variants.map((v) => v.seed)).toEqual(survivors.map((v) => v.seed));
    expect(after.value.variants.map((v) => `${v.productId}/v${v.index}`)).toEqual(
      survivors.map((v) => `${v.productId}/v${v.index}`),
    );
    // Slot 2 is gone and is not reborn under anyone else's index.
    expect(after.value.variants.some((v) => v.index === 2)).toBe(false);
    expect(after.value.variants.some((v) => v.seed === seedFrom("golden", "2", "0"))).toBe(false);
    expect(after.value.estimate.creatives).toBe(11);
  });

  test("a delete on a brief that needed the exhaustive search also keeps its survivors", () => {
    // At this brief's derived seed the 3 × allocated random draw reaches only 7
    // of 8, so this plan comes from `exhaustiveAccept`. A delete leaves
    // `nextIndex` at `count`, so that search is asked the identical question and
    // returns the identical set — which is why the gate on the fallback is
    // `allocated === count` and not "the brief has no tombstones".
    const before = planner().plan(tightBrief(8, undefined, "derived"), tightInput);
    const after = planner().plan(
      tightBrief(8, { nextIndex: 8, tombstoned: [3] }, "derived"),
      tightInput,
    );
    expect(before.success).toBe(true);
    expect(after.success).toBe(true);
    if (!before.success || !after.success) return;
    expect(before.value.variants).toHaveLength(8);
    expect(after.value.variants).toEqual(before.value.variants.filter((v) => v.index !== 3));
    // This test used to demonstrate its premise — "not reachable by the random
    // draw alone" — by asking for the same eight slots as seven-plus-an-append
    // and watching that fall short. **That proxy is gone, deliberately.** An
    // appended slot now gets its own draw floor, so it places, and the proxy
    // would be measuring the floor rather than the fallback. The premise itself
    // is unchanged and still load-bearing: both plans here are DENSE
    // (`allocated === count === 8`), the floor never applies to them, and their
    // draw sequence is the pre-SL2 sequence instruction for instruction — which
    // is exactly why the fallback's gate is `allocated === count` and not "the
    // brief has no tombstones".
  });

  test("an eighth creative the space has room for is PLACED, and the seven keep their draw", () => {
    // This brief used to refuse here, and the refusal was false. Seven creatives
    // exist, the space holds eight at this distance, and an eighth point is
    // reachable — the draw simply had no turns left for it: the shared pool is
    // `allocated × 3`, spent in order, and the appended slot is both last and the
    // most constrained, since it must clear all seven. The exhaustive fallback is
    // closed for an append (re-choosing would rewrite the seven), so "out of
    // turns" was being reported as "this brief cannot fit".
    const before = planner().plan(tightBrief(7, undefined, "derived"), tightInput);
    const appended = planner().plan(tightBrief(7, { nextIndex: 8 }, "derived"), tightInput);
    expect(before.success).toBe(true);
    expect(appended.success).toBe(true);
    if (!before.success || !appended.success) return;
    expect(before.value.variants).toHaveLength(7);
    expect(appended.value.variants).toHaveLength(8);
    // The guarantee the old refusal was protecting, now held while SUCCEEDING:
    // the seven are byte-identical and in place. Nothing was bought by moving
    // them — the eighth was added beside them.
    expect(appended.value.variants.slice(0, 7)).toEqual(before.value.variants);
    expect(appended.value.variants[7]?.index).toBe(7);
  });

  test("an append the space genuinely cannot hold is still refused, and says so", () => {
    // The other half, and the reason the floor is a floor rather than a licence:
    // at `minDistance 2` this brief holds eight points. A ninth does not exist at
    // any budget, so no number of extra draws may turn this into a success — and
    // the message still tells the operator the existing creatives keep their draw.
    const appended = planner().plan(tightBrief(8, { nextIndex: 9 }, "derived"), tightInput);
    expect(appended.success).toBe(false);
    if (appended.success) return;
    expect(appended.error.message).toMatch(/Variation plan shortfall: accepted 8 of count 9\./);
    expect(appended.error.message).toMatch(/Existing creatives keep their draw \(8 of 9 slots/);
    expect(appended.error.message).toMatch(/To fix: delete a creative/);
    // And it names the constraint that actually binds. The capacity sentence
    // that follows says "at most 8 distinct variants" — true of the space, and
    // read as spare room by an operator holding eight of them. The real answer
    // is that nothing left in the space clears the creatives they have.
    expect(appended.error.message).toMatch(
      /No remaining combination is 2 or more away from the creatives you already have\./,
    );
  });

  test("an added creative takes a fresh index above every index ever used, never a tombstoned one", () => {
    const before = planner().plan(occupancyBrief(undefined));
    // Two deleted (2 and 5) and two added: the cursor has run to 14.
    const after = planner().plan(occupancyBrief({ nextIndex: 14, tombstoned: [2, 5] }));
    expect(before.success).toBe(true);
    expect(after.success).toBe(true);
    if (!before.success || !after.success) return;

    expect(after.value.variants.map((v) => v.index)).toEqual([
      0, 1, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    const survivors = before.value.variants.filter((v) => v.index !== 2 && v.index !== 5);
    expect(after.value.variants.filter((v) => v.index < 12)).toEqual(survivors);
    const added = after.value.variants.filter((v) => v.index >= 12);
    expect(added.map((v) => v.index)).toEqual([12, 13]);
    for (const variant of added) {
      expect(variant.seed).toBe(seedFrom("golden", String(variant.index), "0"));
    }
  });

  test("an appended creative is distanced against the occupants, which keep their draw", () => {
    // 24 points at minDistance 2 hold exactly 8. Seven exist; the eighth has to be
    // chosen so that it conflicts with none of them, and the seven do not move.
    const before = planner().plan(tightBrief(7), tightInput);
    const after = planner().plan(tightBrief(7, { nextIndex: 8 }), tightInput);
    expect(before.success).toBe(true);
    expect(after.success).toBe(true);
    if (!before.success || !after.success) return;

    expect(after.value.variants).toHaveLength(8);
    expect(after.value.variants.slice(0, 7)).toEqual(before.value.variants);
    const appended = after.value.variants[7];
    expect(appended.index).toBe(7);
    for (const occupant of before.value.variants) {
      expect(hamming(appended, occupant), `appended vs ${occupant.index}`).toBeGreaterThanOrEqual(
        2,
      );
    }
    expectDistanceHeld(after.value);
  });

  test("an append the occupants leave no room for is refused loudly, naming the shortfall", () => {
    // Eight is the capacity. A ninth cannot be placed at minDistance 2 without
    // moving one of the eight — so the request is refused rather than silently
    // reshuffling the operator's creatives to make room, and rather than
    // returning eight and calling it nine.
    const refused = planner().plan(tightBrief(8, { nextIndex: 9 }), tightInput);
    expect(refused.success).toBe(false);
    if (refused.success) return;
    expect(refused.error.message).toMatch(/Variation plan shortfall: accepted 8 of count 9\./);
    expect(refused.error.message).toMatch(
      /Existing creatives keep their draw \(8 of 9 slots are already occupied\), so the shortfall is in the slots still to allocate\./,
    );
    expect(refused.error.message).toMatch(/At minDistance 2 this brief can yield at most 8/);
    expect(refused.error.message).toMatch(/To fix: delete a creative, lower count to 8/);
  });

  test("a delete that drops the brief below its own coverage floor says which delete did it", () => {
    // Three slots, one per ratio, perRatio 1. Deleting any of the three leaves a
    // ratio with none — a real state an operator can reach, and one the planner
    // must not emit in silence.
    const result = planner().plan(
      occupancyBrief({ nextIndex: 3, tombstoned: [1] }, { count: 3, coverage: { perRatio: 1 } }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/coverage unmet: ratio "16:9" has 0 of perRatio 1/);
    expect(result.error.message).toMatch(/\(1 deleted slot: 1\)/);
    // The same brief with nothing deleted plans, so the tombstone is the cause.
    const dense = planner().plan(
      occupancyBrief(undefined, { count: 3, coverage: { perRatio: 1 } }),
    );
    expect(dense.success).toBe(true);
  });

  test("the plural of the tombstone note tracks the number of deleted slots", () => {
    const result = planner().plan(
      occupancyBrief({ nextIndex: 3, tombstoned: [0, 1] }, { count: 3, coverage: { perRatio: 1 } }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/\(2 deleted slots: 0, 1\)/);
  });

  test("the axisProductSize guard counts allocated slots, not the recipe's count", () => {
    // Three ratios and nothing else varying: three points. A brief at count 3 that
    // then adds a fourth slot is asking for a fourth point that does not exist.
    const narrow = (occupancy?: Record<string, unknown>): CampaignBrief =>
      brief({
        products: [product("alpha")],
        variation: {
          count: 3,
          seed: 7,
          minDistance: 1,
          axes: { layout: ["headline-top"], tone: ["bold"] },
          ...(occupancy === undefined ? {} : { occupancy }),
        },
      } as Partial<CampaignBrief>);
    expect(planner().plan(narrow()).success).toBe(true);
    const added = planner().plan(narrow({ nextIndex: 4 }));
    expect(added.success).toBe(false);
    if (added.success) return;
    expect(added.error.message).toMatch(/Variation count 4 exceeds axisProductSize 3\./);
  });
});

describe("PlanVariationsUseCase.replan — a slot is not a position (H1)", () => {
  /** Slots 0, 1 and 3: `variants.length` is 3, and the highest slot is 3. */
  const holey = (): { plan: VariationPlan; brief: CampaignBrief } => {
    const source = occupancyBrief({ nextIndex: 4, tombstoned: [2] }, { count: 4 });
    const planned = planner().plan(source);
    if (!planned.success) throw planned.error;
    return { plan: planned.value, brief: source };
  };

  test("the planned set really is holey, so the rest of this block means something", () => {
    const { plan } = holey();
    expect(plan.variants.map((v) => v.index)).toEqual([0, 1, 3]);
    expect(plan.variants).toHaveLength(3);
  });

  test("re-rolling the highest slot of a holey set succeeds", () => {
    // The bug this replaces: `index >= plan.variants.length` refused slot 3
    // because the survivors number 3, and `plan.variants[3]` was `undefined`.
    const { plan } = holey();
    const result = planner().replan(plan, 3, 1);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.variants.map((v) => v.index)).toEqual([0, 1, 3]);
    const rerolled = result.value.variants[2];
    expect(rerolled.index).toBe(3);
    expect(rerolled.seed).toBe(seedFrom("golden", "3", "1"));
    // The other two slots are untouched by the re-roll.
    expect(result.value.variants.slice(0, 2)).toEqual(plan.variants.slice(0, 2));
  });

  test("re-rolling a low slot of a holey set replaces that slot and no other", () => {
    const { plan } = holey();
    const result = planner().replan(plan, 1, 1);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.variants.map((v) => v.index)).toEqual([0, 1, 3]);
    expect(result.value.variants[1].seed).toBe(seedFrom("golden", "1", "1"));
    expect(result.value.variants[0]).toEqual(plan.variants[0]);
    expect(result.value.variants[2]).toEqual(plan.variants[2]);
  });

  test("a tombstoned slot is not a valid re-roll target, even though it is in range", () => {
    // Slot 2 sits between two live slots, so no bound on the index can catch it —
    // only membership in the planned set can.
    const { plan } = holey();
    const result = planner().replan(plan, 2, 1);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toBe("Invalid variant index 2.");
  });

  test("a slot above the cursor is still refused", () => {
    const { plan } = holey();
    expect(planner().replan(plan, 4, 1).success).toBe(false);
  });
});
