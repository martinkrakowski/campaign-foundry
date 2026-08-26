import { describe, test, expect } from "vitest";
import { seedFrom } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../entities/CampaignBrief.js";
import type { Product } from "../../entities/Product.js";
import { LAYOUT_VALUES, TONE_VALUES } from "../Treatment.vo.js";
import { BACKGROUND_AXIS_SOURCES, DISTANCE_AXES, HEADLINE_POOL_REF, VariationPolicy } from "../VariationPolicy.vo.js";

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
  ...over,
});

describe("VariationPolicy.fromBrief", () => {
  test.each([
    ["when variation is absent", brief()],
    ["when variation omits count", brief({ variation: {} })],
    ["when variation has seed but no count", brief({ variation: { seed: 7 } })],
  ])("rejects %s", (_label, input) => {
    const result = VariationPolicy.fromBrief(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/count/);
  });

  test("defaults unlocked axes, coverage, minDistance and seed", () => {
    const result = VariationPolicy.fromBrief(brief({ variation: { count: 12 } }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const policy = result.value;
    expect(policy.count).toBe(12);
    expect(policy.seed).toBe(seedFrom("golden"));
    expect(policy.minDistance).toBe(1);
    expect(policy.coverage).toEqual({ perProduct: 0, perRatio: 0 });
    expect(policy.layout).toEqual([...LAYOUT_VALUES]);
    expect(policy.tone).toEqual([...TONE_VALUES]);
    expect(policy.backgroundSource).toEqual(["procedural"]);
    expect(policy.paletteShift).toEqual([0]);
    expect(policy.productIds).toEqual(["alpha", "beta"]);
    expect(policy.ratios).toEqual(["1:1", "9:16", "16:9"]);
    expect(policy.axisProductSize).toBe(2 * 3 * 2 * 2 * 1 * 1);
  });

  test("uses a provided seed, minDistance and coverage", () => {
    const result = VariationPolicy.fromBrief(
      brief({
        variation: { count: 4, seed: 7, minDistance: 2, coverage: { perProduct: 1, perRatio: 1 } },
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.seed).toBe(7);
    expect(result.value.minDistance).toBe(2);
    expect(result.value.coverage).toEqual({ perProduct: 1, perRatio: 1 });
  });

  test.each([
    [{ perProduct: 2 }, { perProduct: 2, perRatio: 0 }],
    [{ perRatio: 1 }, { perProduct: 0, perRatio: 1 }],
  ] as const)("defaults the omitted coverage field for %j", (coverage, expected) => {
    const result = VariationPolicy.fromBrief(brief({ variation: { count: 4, coverage } }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.coverage).toEqual(expected);
  });

  test("unlocks only the listed axis options", () => {
    const result = VariationPolicy.fromBrief(
      brief({
        variation: {
          count: 4,
          axes: {
            layout: ["headline-top"],
            tone: ["subtle"],
            background: { source: ["asset-pool", "genai"] },
            paletteShift: [0, 0.2],
          },
        },
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.layout).toEqual(["headline-top"]);
    expect(result.value.tone).toEqual(["subtle"]);
    expect(result.value.backgroundSource).toEqual(["asset-pool", "genai"]);
    expect(result.value.paletteShift).toEqual([0, 0.2]);
    expect(result.value.axisProductSize).toBe(2 * 3 * 1 * 1 * 2 * 2);
  });

  test("defaults backgroundSource when axes.background omits source", () => {
    const result = VariationPolicy.fromBrief(
      brief({ variation: { count: 1, axes: { background: {} } } }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.backgroundSource).toEqual(["procedural"]);
  });

  test("preserves product id order", () => {
    const result = VariationPolicy.fromBrief(
      brief({ products: [product("zeta"), product("alpha")], variation: { count: 1 } }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.productIds).toEqual(["zeta", "alpha"]);
  });

  test("policyHash is the sha256 of canonical policy JSON (golden)", () => {
    const result = VariationPolicy.fromBrief(brief({ variation: { count: 12, seed: 7, minDistance: 1 } }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.policyHash).toBe(
      "7181107a6ce42df96357800416bf26bf89007fd3dbd2b9792aab83323adefcf9",
    );
  });

  test("the same brief yields the same policyHash twice", () => {
    const input = brief({ variation: { count: 12, seed: 7 } });
    const a = VariationPolicy.fromBrief(input);
    const b = VariationPolicy.fromBrief(input);
    expect(a.success && b.success).toBe(true);
    if (a.success && b.success) expect(a.value.policyHash).toBe(b.value.policyHash);
  });

  test("BACKGROUND_AXIS_SOURCES is the brief-parser set", () => {
    expect(BACKGROUND_AXIS_SOURCES).toEqual(["procedural", "asset-pool", "genai"]);
  });

  test.each([
    [{ count: 0 }, /count/],
    [{ count: -1 }, /count/],
    [{ count: 1.5 }, /count/],
    [{ count: Number.POSITIVE_INFINITY }, /count/],
    [{ count: Number.NaN }, /count/],
    [{ count: 1, minDistance: -1 }, /minDistance/],
    [{ count: 1, minDistance: 8 }, /minDistance/],
    [{ count: 1, minDistance: 1.5 }, /minDistance/],
    [{ count: 1, minDistance: Number.POSITIVE_INFINITY }, /minDistance/],
    [{ count: 1, coverage: { perProduct: -1 } }, /coverage\.perProduct/],
    [{ count: 1, coverage: { perProduct: 0.5 } }, /coverage\.perProduct/],
    [{ count: 1, coverage: { perProduct: Number.NaN } }, /coverage\.perProduct/],
    [{ count: 1, coverage: { perRatio: -1 } }, /coverage\.perRatio/],
    [{ count: 1, coverage: { perRatio: 1.5 } }, /coverage\.perRatio/],
    [{ count: 1, coverage: { perRatio: Number.POSITIVE_INFINITY } }, /coverage\.perRatio/],
    [{ count: 1, seed: -1 }, /seed/],
    [{ count: 1, seed: 0.5 }, /seed/],
    [{ count: 1, seed: 2 ** 32 }, /seed/],
    [{ count: 1, seed: Number.NaN }, /seed/],
    [{ count: 1, axes: { paletteShift: [-0.1] } }, /paletteShift/],
    [{ count: 1, axes: { paletteShift: [1.1] } }, /paletteShift/],
    [{ count: 1, axes: { paletteShift: [Number.NaN] } }, /paletteShift/],
    [{ count: 1, axes: { paletteShift: [Number.POSITIVE_INFINITY] } }, /paletteShift/],
  ] as const)("rejects invalid %j", (variation, pattern) => {
    const result = VariationPolicy.fromBrief(brief({ variation: { ...variation } }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(pattern);
  });

  test.each([
    [{ count: 1, minDistance: 0 }, "minDistance", 0],
    [{ count: 1, minDistance: 6 }, "minDistance", 6],
    [{ count: 1, seed: 0 }, "seed", 0],
    [{ count: 1, seed: 0xffffffff }, "seed", 0xffffffff],
  ] as const)("accepts boundary %j", (variation, field, expected) => {
    const result = VariationPolicy.fromBrief(brief({ variation: { ...variation } }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value[field]).toBe(expected);
  });

  test("rejects a non-numeric paletteShift", () => {
    const result = VariationPolicy.fromBrief(
      brief({
        variation: { count: 1, axes: { paletteShift: ["nope"] as unknown as number[] } },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/paletteShift/);
  });

  test("accepts paletteShift endpoints 0 and 1", () => {
    const result = VariationPolicy.fromBrief(
      brief({ variation: { count: 1, axes: { paletteShift: [0, 1] } } }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.paletteShift).toEqual([0, 1]);
  });

  test("canonicalises duplicate layout values before hashing", () => {
    const duplicated = VariationPolicy.fromBrief(
      brief({ variation: { count: 1, seed: 7, axes: { layout: ["bold", "bold"] } } }),
    );
    const once = VariationPolicy.fromBrief(
      brief({ variation: { count: 1, seed: 7, axes: { layout: ["bold"] } } }),
    );
    expect(duplicated.success && once.success).toBe(true);
    if (!duplicated.success || !once.success) return;
    expect(duplicated.value.layout).toEqual(["bold"]);
    expect(duplicated.value.axisProductSize).toBe(once.value.axisProductSize);
    expect(duplicated.value.policyHash).toBe(once.value.policyHash);
  });

  test("canonicalises duplicate product ids before axisProductSize", () => {
    const result = VariationPolicy.fromBrief(
      brief({
        products: [product("alpha"), product("alpha"), product("beta")],
        variation: { count: 1, seed: 7, axes: { layout: ["headline-top"], tone: ["bold"] } },
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.productIds).toEqual(["alpha", "beta"]);
    expect(result.value.axisProductSize).toBe(2 * 3 * 1 * 1 * 1 * 1);
  });
});

describe("VariationPolicy headline axis", () => {
  const pooled = brief({ variation: { count: 12, seed: 7, minDistance: 1, axes: { headline: "pool://copy" } } });

  test("headline is a Hamming axis and pool://copy is the only pool reference", () => {
    expect(DISTANCE_AXES).toContain("headline");
    expect(HEADLINE_POOL_REF).toBe("pool://copy");
  });

  test("resolves the pool texts (trimmed, de-duplicated, blanks dropped) and multiplies axisProductSize", () => {
    const result = VariationPolicy.fromBrief(pooled, { headlines: [" Stay wild ", "Stay wild", "", "Go far"] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.headline).toEqual(["Stay wild", "Go far"]);
    expect(result.value.axisProductSize).toBe(2 * 3 * 2 * 2 * 1 * 1 * 2);
    expect(result.value.policyHash).not.toBe(
      "7181107a6ce42df96357800416bf26bf89007fd3dbd2b9792aab83323adefcf9",
    );
  });

  test("briefs without the axis keep an empty headline list and the golden hash, even when headlines are supplied", () => {
    const result = VariationPolicy.fromBrief(brief({ variation: { count: 12, seed: 7, minDistance: 1 } }), {
      headlines: ["Ignored"],
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.headline).toEqual([]);
    expect(result.value.axisProductSize).toBe(24);
    expect(result.value.policyHash).toBe(
      "7181107a6ce42df96357800416bf26bf89007fd3dbd2b9792aab83323adefcf9",
    );
  });

  test.each([
    ["no input", undefined],
    ["an empty pool", []],
    ["only blank texts", ["  "]],
  ])("fails naming the pool file when pool://copy is requested with %s", (_label, headlines) => {
    const result = VariationPolicy.fromBrief(pooled, headlines === undefined ? undefined : { headlines });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Headline axis "pool://copy" needs at least one approved entry in copy pool briefs/golden/pools.json.',
      );
    }
  });

  test("rejects any other headline reference", () => {
    const result = VariationPolicy.fromBrief(
      brief({ variation: { count: 1, axes: { headline: "pool://other" } } }),
      { headlines: ["x"] },
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/Unsupported headline axis "pool:\/\/other"/);
  });
});
