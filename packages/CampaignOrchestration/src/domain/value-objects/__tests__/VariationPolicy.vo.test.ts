import { describe, test, expect } from "vitest";
import { seedFrom } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../entities/CampaignBrief.js";
import type { Product } from "../../entities/Product.js";
import { LAYOUT_VALUES, TONE_VALUES } from "../Treatment.vo.js";
import { BACKGROUND_AXIS_SOURCES, VariationPolicy } from "../VariationPolicy.vo.js";

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
});
