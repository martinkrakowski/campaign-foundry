import { describe, test, expect } from "vitest";
import { seedFrom } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../entities/CampaignBrief.js";
import type { Product } from "../../entities/Product.js";
import { LAYOUT_VALUES, TONE_VALUES } from "../Treatment.vo.js";
import {
  BACKGROUND_AXIS_SOURCES,
  canonicalHeadlines,
  DISTANCE_AXES,
  HEADLINE_POOL_REF,
  VariationPolicy,
} from "../VariationPolicy.vo.js";

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
    expect(policy.motion).toEqual([]);
    expect(policy.duration).toEqual([6]);
    expect(policy.motionEnabled).toBe(false);
    expect(policy.mixStatic).toBe(false);
    expect(policy.motionRatios).toEqual(["1:1", "9:16", "16:9"]);
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

  test("minDistance is bounded by the active axes: 6 for a static brief, 8 once motion is on", () => {
    const motionOn = (minDistance: number) =>
      VariationPolicy.fromBrief(
        brief({
          variation: { count: 1, minDistance, axes: { motion: ["ken-burns-in"] } },
          output: { formats: ["motion"] },
        }),
      );
    // A motion axis that cannot be drawn (no motion format) does not count.
    const motionOff = (minDistance: number) =>
      VariationPolicy.fromBrief(
        brief({ variation: { count: 1, minDistance, axes: { motion: ["ken-burns-in"] } } }),
      );
    expect(VariationPolicy.fromBrief(brief({ variation: { count: 1, minDistance: 6 } })).success).toBe(true);
    expect(motionOn(8).success).toBe(true);
    expect(motionOn(9).success).toBe(false);
    expect(motionOff(6).success).toBe(true);
    expect(motionOff(7).success).toBe(false);
  });

  test("motionRatios narrows to the plan input and joins the hash only for motion briefs", () => {
    const motion = brief({
      variation: { count: 1, axes: { motion: ["ken-burns-in"] } },
      output: { formats: ["motion"] },
    });
    const all = VariationPolicy.fromBrief(motion);
    const vertical = VariationPolicy.fromBrief(motion, { motionRatios: ["9:16", "9:16"] });
    const none = VariationPolicy.fromBrief(motion, { motionRatios: [] });
    expect(all.success && vertical.success && none.success).toBe(true);
    if (!all.success || !vertical.success || !none.success) return;
    expect(all.value.motionRatios).toEqual(["1:1", "9:16", "16:9"]);
    expect(vertical.value.motionRatios).toEqual(["9:16"]);
    expect(none.value.motionRatios).toEqual([]);
    expect(vertical.value.policyHash).not.toBe(all.value.policyHash);

    const still = brief({ variation: { count: 12, seed: 7, minDistance: 1 } });
    const golden = VariationPolicy.fromBrief(still);
    const narrowed = VariationPolicy.fromBrief(still, { motionRatios: ["9:16"] });
    expect(golden.success && narrowed.success).toBe(true);
    if (golden.success && narrowed.success) expect(narrowed.value.policyHash).toBe(golden.value.policyHash);
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
    [{ count: 1, minDistance: 7 }, /minDistance/],
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

  test("resolves the pool texts (trimmed, de-duplicated, blanks dropped, sorted) and multiplies axisProductSize", () => {
    const result = VariationPolicy.fromBrief(pooled, { headlines: [" Stay wild ", "Stay wild", "", "Go far"] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.headline).toEqual(["Go far", "Stay wild"]);
    expect(result.value.axisProductSize).toBe(2 * 3 * 2 * 2 * 1 * 1 * 2);
    expect(result.value.policyHash).not.toBe(
      "7181107a6ce42df96357800416bf26bf89007fd3dbd2b9792aab83323adefcf9",
    );
  });

  test("the same approved set in any file order yields one canonical list and one policyHash", () => {
    const a = VariationPolicy.fromBrief(pooled, { headlines: ["Stay wild", "Go far", "stay  WILD", "Drink up"] });
    const b = VariationPolicy.fromBrief(pooled, { headlines: ["Drink up", "stay  WILD", "Go far", "Stay wild"] });
    expect(a.success && b.success).toBe(true);
    if (!a.success || !b.success) return;
    expect(a.value.headline).toEqual(["Drink up", "Go far", "Stay wild"]);
    expect(b.value.headline).toEqual(["Drink up", "Go far", "Stay wild"]);
    expect(a.value.policyHash).toBe(b.value.policyHash);
    // Code-unit order, not locale order: upper-case sorts before lower-case, so the
    // de-duplication keeps "STAY WILD" when it is the first survivor in that order.
    expect(canonicalHeadlines(["stay wild", "STAY WILD", "Zebra", "apple"])).toEqual(["STAY WILD", "Zebra", "apple"]);
  });

  test("minDistance may reach the seventh axis only when the headline axis is active", () => {
    const seven = { count: 1, seed: 7, minDistance: 7 };
    const without = VariationPolicy.fromBrief(brief({ variation: seven }));
    expect(without.success).toBe(false);
    if (!without.success) expect(without.error.message).toBe("Invalid minDistance.");
    const withPool = VariationPolicy.fromBrief(
      brief({ variation: { ...seven, axes: { headline: "pool://copy" } } }),
      { headlines: ["Stay wild"] },
    );
    expect(withPool.success).toBe(true);
    if (withPool.success) expect(withPool.value.minDistance).toBe(7);
    const eight = VariationPolicy.fromBrief(
      brief({ variation: { ...seven, minDistance: 8, axes: { headline: "pool://copy" } } }),
      { headlines: ["Stay wild"] },
    );
    expect(eight.success).toBe(false);
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
