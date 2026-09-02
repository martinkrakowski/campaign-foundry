import { describe, test, expect, vi } from "vitest";
import { seedFrom } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../entities/CampaignBrief.js";
import type { Product } from "../../entities/Product.js";
import { LAYOUT_VALUES, TONE_VALUES } from "../Treatment.vo.js";
import { MOTION_KINDS } from "../MotionKind.vo.js";
import {
  ANCHOR_VALUES,
  BACKGROUND_AXIS_SOURCES,
  canonicalHeadlines,
  DISTANCE_AXES,
  HEADLINE_POOL_REF,
  VariationPolicy,
  type PlanInput,
  type PolicyHasher,
} from "../VariationPolicy.vo.js";
import { nodeCryptoPolicyHasher } from "../../../infrastructure/index.js";

const fromBrief = (
  b: CampaignBrief,
  input: PlanInput = {},
  hasher: PolicyHasher = nodeCryptoPolicyHasher,
) => VariationPolicy.fromBrief(b, input, hasher);

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
    const result = fromBrief(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/count/);
  });

  test("defaults unlocked axes, coverage, minDistance and seed", () => {
    const result = fromBrief(brief({ variation: { count: 12 } }));
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
    const result = fromBrief(
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
    const result = fromBrief(brief({ variation: { count: 4, coverage } }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.coverage).toEqual(expected);
  });

  test("unlocks only the listed axis options", () => {
    const result = fromBrief(
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
    const result = fromBrief(
      brief({ variation: { count: 1, axes: { background: {} } } }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.backgroundSource).toEqual(["procedural"]);
  });

  test("preserves product id order", () => {
    const result = fromBrief(
      brief({ products: [product("zeta"), product("alpha")], variation: { count: 1 } }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.productIds).toEqual(["zeta", "alpha"]);
  });

  test("policyHash is the sha256 of canonical policy JSON (golden)", () => {
    const result = fromBrief(brief({ variation: { count: 12, seed: 7, minDistance: 1 } }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.policyHash).toBe(
      "7181107a6ce42df96357800416bf26bf89007fd3dbd2b9792aab83323adefcf9",
    );
  });

  test("the same brief yields the same policyHash twice", () => {
    const input = brief({ variation: { count: 12, seed: 7 } });
    const a = fromBrief(input);
    const b = fromBrief(input);
    expect(a.success && b.success).toBe(true);
    if (a.success && b.success) expect(a.value.policyHash).toBe(b.value.policyHash);
  });


  test("delegates hashing to the supplied PolicyHasher", () => {
    const customHasher = vi.fn((_payloadJson: string) => "custom-digest-12345");
    const result = VariationPolicy.fromBrief(
      brief({ variation: { count: 4, seed: 7 } }),
      {},
      customHasher,
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(customHasher).toHaveBeenCalledTimes(1);
    const passedJson = customHasher.mock.calls[0]?.[0];
    expect(typeof passedJson).toBe("string");
    if (passedJson !== undefined) {
      expect(JSON.parse(passedJson)).toMatchObject({
        count: 4,
        seed: 7,
      });
    }
    expect(result.value.policyHash).toBe("custom-digest-12345");
  });

  test("minDistance is bounded by the active axes: 6 for a static brief, 8 once motion is on", () => {
    const motionOn = (minDistance: number) =>
      fromBrief(
        brief({
          variation: { count: 1, minDistance, axes: { motion: ["ken-burns-in"] } },
          output: { formats: ["motion"] },
        }),
      );
    // A motion axis that cannot be drawn (no motion format) does not count.
    const motionOff = (minDistance: number) =>
      fromBrief(
        brief({ variation: { count: 1, minDistance, axes: { motion: ["ken-burns-in"] } } }),
      );
    expect(fromBrief(brief({ variation: { count: 1, minDistance: 6 } })).success).toBe(true);
    expect(motionOn(8).success).toBe(true);
    expect(motionOn(9).success).toBe(false);
    expect(motionOff(6).success).toBe(true);
    expect(motionOff(7).success).toBe(false);
  });

  test("formats: motion with no motion axis defaults to every MOTION_KINDS entry (every variant a clip)", () => {
    const result = fromBrief(
      brief({ variation: { count: 1 }, output: { formats: ["motion"] } }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.motion).toEqual([...MOTION_KINDS]);
    expect(result.value.motionEnabled).toBe(true);
    expect(result.value.mixStatic).toBe(false);
  });

  test("formats: motion with an explicitly empty motion axis is rejected", () => {
    const result = fromBrief(
      brief({ variation: { count: 1, axes: { motion: [] } }, output: { formats: ["motion"] } }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/select at least one motion kind/);
  });

  test("an empty motion axis without the motion format stays a static policy", () => {
    const result = fromBrief(brief({ variation: { count: 1, axes: { motion: [] } } }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.value.motionEnabled).toBe(false);
  });

  test("formats: [static, motion] mixes (still slot kept); [motion] alone does not", () => {
    const mixed = fromBrief(
      brief({ variation: { count: 1, axes: { motion: ["ken-burns-in"] } }, output: { formats: ["static", "motion"] } }),
    );
    const clipsOnly = fromBrief(
      brief({ variation: { count: 1, axes: { motion: ["ken-burns-in"] } }, output: { formats: ["motion"] } }),
    );
    expect(mixed.success && clipsOnly.success).toBe(true);
    if (!mixed.success || !clipsOnly.success) return;
    expect(mixed.value.mixStatic).toBe(true);
    expect(clipsOnly.value.mixStatic).toBe(false);
  });

  test("axisProductSize counts the mixed still slot once, not per duration", () => {
    // base = 2 products × 3 ratios × 1 layout × 1 tone × 1 background × 1 shift = 6
    const axes = { layout: ["headline-top"], tone: ["bold"], motion: ["ken-burns-in", "headline-rise"], duration: [4, 6] };
    const mixed = fromBrief(
      brief({ variation: { count: 1, axes }, output: { formats: ["static", "motion"] } }),
    );
    const clipsOnly = fromBrief(
      brief({ variation: { count: 1, axes }, output: { formats: ["motion"] } }),
    );
    expect(mixed.success && clipsOnly.success).toBe(true);
    if (!mixed.success || !clipsOnly.success) return;
    expect(mixed.value.axisProductSize).toBe(6 * (2 * 2 + 1)); // 30, not 6 × 3 × 2 = 36
    expect(clipsOnly.value.axisProductSize).toBe(6 * (2 * 2)); // 24
  });

  test("motionRatios narrows to the plan input and joins the hash only for motion briefs", () => {
    const motion = brief({
      variation: { count: 1, axes: { motion: ["ken-burns-in"] } },
      output: { formats: ["motion"] },
    });
    const all = fromBrief(motion);
    const vertical = fromBrief(motion, { motionRatios: ["9:16", "9:16"] });
    expect(all.success && vertical.success).toBe(true);
    if (!all.success || !vertical.success) return;
    expect(all.value.motionRatios).toEqual(["1:1", "9:16", "16:9"]);
    expect(vertical.value.motionRatios).toEqual(["9:16"]);
    expect(vertical.value.policyHash).not.toBe(all.value.policyHash);
    // A motion-only brief with no ratio it can be motion at used to succeed here and
    // then plan every slot as a still — the defect this rule closes. It is refused.
    const none = fromBrief(motion, { motionRatios: [] });
    expect(none.success).toBe(false);

    const still = brief({ variation: { count: 12, seed: 7, minDistance: 1 } });
    const golden = fromBrief(still);
    const narrowed = fromBrief(still, { motionRatios: ["9:16"] });
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
    [{ count: 1, axes: { paletteShift: [1] } }, /paletteShift/],
    [{ count: 1, axes: { paletteShift: [1.1] } }, /paletteShift/],
    [{ count: 1, axes: { paletteShift: [Number.NaN] } }, /paletteShift/],
    [{ count: 1, axes: { paletteShift: [Number.POSITIVE_INFINITY] } }, /paletteShift/],
  ] as const)("rejects invalid %j", (variation, pattern) => {
    const result = fromBrief(brief({ variation: { ...variation } }));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(pattern);
  });

  test.each([
    [{ count: 1, minDistance: 0 }, "minDistance", 0],
    [{ count: 1, minDistance: 6 }, "minDistance", 6],
    [{ count: 1, seed: 0 }, "seed", 0],
    [{ count: 1, seed: 0xffffffff }, "seed", 0xffffffff],
  ] as const)("accepts boundary %j", (variation, field, expected) => {
    const result = fromBrief(brief({ variation: { ...variation } }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value[field]).toBe(expected);
  });

  test("rejects a non-numeric paletteShift", () => {
    const result = fromBrief(
      brief({
        variation: { count: 1, axes: { paletteShift: ["nope"] as unknown as number[] } },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/paletteShift/);
  });

  test("accepts paletteShift endpoint 0 and refuses 1 (a whole turn is identical to 0)", () => {
    const accepted = fromBrief(
      brief({ variation: { count: 1, axes: { paletteShift: [0] } } }),
    );
    expect(accepted.success).toBe(true);
    if (!accepted.success) return;
    expect(accepted.value.paletteShift).toEqual([0]);

    const refused = fromBrief(
      brief({ variation: { count: 1, axes: { paletteShift: [1] } } }),
    );
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.message).toMatch(/paletteShift/);
      expect(refused.error.message).toMatch(/\[0, 1\)/);
    }
  });

  test("canonicalises duplicate layout values before hashing", () => {
    const duplicated = fromBrief(
      brief({ variation: { count: 1, seed: 7, axes: { layout: ["bold", "bold"] } } }),
    );
    const once = fromBrief(
      brief({ variation: { count: 1, seed: 7, axes: { layout: ["bold"] } } }),
    );
    expect(duplicated.success && once.success).toBe(true);
    if (!duplicated.success || !once.success) return;
    expect(duplicated.value.layout).toEqual(["bold"]);
    expect(duplicated.value.axisProductSize).toBe(once.value.axisProductSize);
    expect(duplicated.value.policyHash).toBe(once.value.policyHash);
  });

  test("canonicalises duplicate product ids before axisProductSize", () => {
    const result = fromBrief(
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

describe("VariationPolicy anchor axis", () => {
  // The golden hash every pre-anchor brief must keep (D57 — the re-roll path
  // pins the persisted hash, so an absent axis must join nothing).
  const GOLDEN_HASH = "7181107a6ce42df96357800416bf26bf89007fd3dbd2b9792aab83323adefcf9";

  test("anchor is a Hamming axis and the vocabulary is the parser's", () => {
    expect(DISTANCE_AXES).toContain("anchor");
    expect(ANCHOR_VALUES).toEqual(["top", "middle", "bottom"]);
  });

  test("an absent axis keeps an empty list, the golden hash and the golden axisProductSize", () => {
    const result = fromBrief(brief({ variation: { count: 12, seed: 7, minDistance: 1 } }));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.anchor).toEqual([]);
    expect(result.value.axisProductSize).toBe(24);
    expect(result.value.policyHash).toBe(GOLDEN_HASH);
  });

  test("a present axis multiplies axisProductSize, joins the hash, and counts as an active axis", () => {
    const anchored = brief({
      variation: { count: 12, seed: 7, minDistance: 1, axes: { anchor: ["middle"] } },
    });
    const result = fromBrief(anchored);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.anchor).toEqual(["middle"]);
    // One anchor value adds no combination to the base 24 — but the axis is in the hash.
    expect(result.value.axisProductSize).toBe(24);
    expect(result.value.policyHash).not.toBe(GOLDEN_HASH);

    // Three values triple the base: 24 × 3.
    const three = fromBrief(
      brief({ variation: { count: 12, seed: 7, axes: { anchor: ["top", "middle", "bottom"] } } }),
    );
    expect(three.success).toBe(true);
    if (three.success) expect(three.value.axisProductSize).toBe(72);

    // minDistance may reach the eighth axis only when the anchor axis is active
    const seven = fromBrief(brief({ variation: { count: 1, minDistance: 7 } }));
    expect(seven.success).toBe(false);
    const withAnchor = fromBrief(
      brief({ variation: { count: 1, minDistance: 7, axes: { anchor: ["top", "middle", "bottom"] } } }),
    );
    expect(withAnchor.success).toBe(true);
    const eight = fromBrief(
      brief({ variation: { count: 1, minDistance: 8, axes: { anchor: ["top", "middle", "bottom"] } } }),
    );
    expect(eight.success).toBe(false);
  });

  test("de-duplicates the axis before hashing and sizing", () => {
    const duplicated = fromBrief(
      brief({ variation: { count: 1, seed: 7, axes: { anchor: ["middle", "middle"] } } }),
    );
    const once = fromBrief(brief({ variation: { count: 1, seed: 7, axes: { anchor: ["middle"] } } }));
    expect(duplicated.success && once.success).toBe(true);
    if (!duplicated.success || !once.success) return;
    expect(duplicated.value.anchor).toEqual(["middle"]);
    expect(duplicated.value.axisProductSize).toBe(once.value.axisProductSize);
    expect(duplicated.value.policyHash).toBe(once.value.policyHash);
  });

  test("absent and an explicit top+bottom pair are different variant spaces", () => {
    // Absent: each variant's anchor derives from its own layout, so the axis
    // joins nothing — the golden 24. An explicit pair makes the planner draw
    // the anchor INDEPENDENTLY of layout: twice the space the absent axis
    // spans, which is exactly why the editor must not collapse the pair back
    // to the absent key on save.
    const absent = fromBrief(brief({ variation: { count: 12, seed: 7 } }));
    const paired = fromBrief(
      brief({ variation: { count: 12, seed: 7, axes: { anchor: ["top", "bottom"] } } }),
    );
    expect(absent.success && paired.success).toBe(true);
    if (!absent.success || !paired.success) return;
    expect(absent.value.anchor).toEqual([]);
    expect(paired.value.anchor).toEqual(["top", "bottom"]);
    expect(paired.value.axisProductSize).toBe(absent.value.axisProductSize * 2);
    expect(paired.value.policyHash).not.toBe(absent.value.policyHash);
  });
});

describe("VariationPolicy requested ratio subset", () => {
  test("narrows ratios and axisProductSize to the requested subset", () => {
    const result = fromBrief(brief({ variation: { count: 4 } }), { ratios: ["1:1", "16:9"] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.ratios).toEqual(["1:1", "16:9"]);
    // 2 products × 2 ratios × 2 layouts × 2 tones × 1 background × 1 shift
    expect(result.value.axisProductSize).toBe(2 * 2 * 2 * 2 * 1 * 1);
  });

  test("de-duplicates the requested subset before sizing the axis", () => {
    const result = fromBrief(brief({ variation: { count: 4 } }), { ratios: ["9:16", "9:16"] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.ratios).toEqual(["9:16"]);
    expect(result.value.axisProductSize).toBe(2 * 1 * 2 * 2 * 1 * 1);
  });

  test("an absent ratios input is byte-for-byte today's behaviour", () => {
    const golden = fromBrief(brief({ variation: { count: 12, seed: 7, minDistance: 1 } }));
    expect(golden.success).toBe(true);
    if (!golden.success) return;
    expect(golden.value.ratios).toEqual(["1:1", "9:16", "16:9"]);
    expect(golden.value.policyHash).toBe(
      "7181107a6ce42df96357800416bf26bf89007fd3dbd2b9792aab83323adefcf9",
    );
    // …including the empty-motionRatios refusal, whose message is unchanged
    const motionOnly = brief({
      variation: { count: 4, axes: { motion: ["ken-burns-in"], duration: [4] } },
      output: { formats: ["motion"], platforms: ["instagram-reel"] },
    });
    const refused = fromBrief(motionOnly, { motionRatios: [] });
    expect(refused.success).toBe(false);
    if (!refused.success) {
      expect(refused.error.message).toBe(
        'output.formats requests only "motion" but none of output.platforms package it at any aspect ratio.',
      );
    }
  });

  test("a requested value that is not an AspectRatioValue is rejected naming the field", () => {
    const result = fromBrief(brief({ variation: { count: 4 } }), {
      ratios: ["4:5"] as never,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Invalid variation.axes.ratio: "4:5" is not a supported aspect ratio (expected one of 1:1, 9:16, 16:9).',
      );
    }
  });

  test("a motion-only brief narrows the requested subset by the motion filter", () => {
    const motionOnly = brief({
      variation: { count: 4, axes: { motion: ["ken-burns-in"], duration: [4] } },
      output: { formats: ["motion"], platforms: ["instagram-reel"] },
    });
    const result = fromBrief(motionOnly, { ratios: ["1:1", "9:16", "16:9"], motionRatios: ["9:16"] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.ratios).toEqual(["9:16"]);
    expect(result.value.axisProductSize).toBe(2 * 1 * 2 * 2 * 1 * 1);
  });

  test("a mixed brief keeps every requested ratio — its non-motion ratios are the stills it asked for", () => {
    const mixed = brief({
      variation: { count: 4, axes: { motion: ["ken-burns-in"], duration: [4] } },
      output: { formats: ["static", "motion"], platforms: ["instagram-reel"] },
    });
    const result = fromBrief(mixed, { ratios: ["1:1", "16:9"], motionRatios: ["9:16"] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.mixStatic).toBe(true);
    expect(result.value.ratios).toEqual(["1:1", "16:9"]);
  });

  test("a requested selection emptied by the motion narrowing names both ratio sets", () => {
    const motionOnly = brief({
      variation: { count: 4, axes: { motion: ["ken-burns-in"], duration: [4] } },
      output: { formats: ["motion"], platforms: ["instagram-reel"] },
    });
    const result = fromBrief(motionOnly, { ratios: ["1:1", "16:9"], motionRatios: ["9:16"] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'output.formats requests only "motion", which the requested platforms package at [9:16], but variation.axes.ratio selects [1:1, 16:9] — select one of those ratios or add the static format.',
      );
    }
  });

  test("an explicitly empty selection is refused as the author's, not blamed on motion", () => {
    const result = fromBrief(brief({ variation: { count: 4 } }), { ratios: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        "Invalid variation.axes.ratio: select at least one aspect ratio (expected one of 1:1, 9:16, 16:9).",
      );
    }
  });
});

describe("VariationPolicy headline axis", () => {
  const pooled = brief({ variation: { count: 12, seed: 7, minDistance: 1, axes: { headline: "pool://copy" } } });

  test("headline is a Hamming axis and pool://copy is the only pool reference", () => {
    expect(DISTANCE_AXES).toContain("headline");
    expect(HEADLINE_POOL_REF).toBe("pool://copy");
  });

  test("resolves the pool texts (trimmed, de-duplicated, blanks dropped, sorted) and multiplies axisProductSize", () => {
    const result = fromBrief(pooled, { headlines: [" Stay wild ", "Stay wild", "", "Go far"] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.headline).toEqual(["Go far", "Stay wild"]);
    expect(result.value.axisProductSize).toBe(2 * 3 * 2 * 2 * 1 * 1 * 2);
    expect(result.value.policyHash).not.toBe(
      "7181107a6ce42df96357800416bf26bf89007fd3dbd2b9792aab83323adefcf9",
    );
  });

  test("the same approved set in any file order yields one canonical list and one policyHash", () => {
    const a = fromBrief(pooled, { headlines: ["Stay wild", "Go far", "stay  WILD", "Drink up"] });
    const b = fromBrief(pooled, { headlines: ["Drink up", "stay  WILD", "Go far", "Stay wild"] });
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
    const without = fromBrief(brief({ variation: seven }));
    expect(without.success).toBe(false);
    if (!without.success) expect(without.error.message).toBe("Invalid minDistance.");
    const withPool = fromBrief(
      brief({ variation: { ...seven, axes: { headline: "pool://copy" } } }),
      { headlines: ["Stay wild"] },
    );
    expect(withPool.success).toBe(true);
    if (withPool.success) expect(withPool.value.minDistance).toBe(7);
    const eight = fromBrief(
      brief({ variation: { ...seven, minDistance: 8, axes: { headline: "pool://copy" } } }),
      { headlines: ["Stay wild"] },
    );
    expect(eight.success).toBe(false);
  });

  test("briefs without the axis keep an empty headline list and the golden hash, even when headlines are supplied", () => {
    const result = fromBrief(brief({ variation: { count: 12, seed: 7, minDistance: 1 } }), {
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
    const result = fromBrief(pooled, headlines === undefined ? undefined : { headlines });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe(
        'Headline axis "pool://copy" needs at least one approved entry in copy pool briefs/golden/pools.json.',
      );
    }
  });

  test("rejects any other headline reference", () => {
    const result = fromBrief(
      brief({ variation: { count: 1, axes: { headline: "pool://other" } } }),
      { headlines: ["x"] },
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/Unsupported headline axis "pool:\/\/other"/);
  });

describe("motion-only briefs draw only at ratios a motion platform packages", () => {
  const motionOnly = (formats: readonly string[]) =>
    brief({
      variation: { count: 4, axes: { motion: ["ken-burns-in"], duration: [4] } },
      output: { formats: [...formats] as never, platforms: ["instagram-reel"] },
    });

  test("the ratio axis narrows to motionRatios, so no slot can fall back to a still", () => {
    const result = fromBrief(motionOnly(["motion"]), { motionRatios: ["9:16"] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.motionEnabled).toBe(true);
    expect(result.value.mixStatic).toBe(false);
    expect(result.value.ratios).toEqual(["9:16"]);
    // axisProductSize follows the narrowed axis: 2 products × 1 ratio × 2 layouts × 2 tones × 1 × 1
    expect(result.value.axisProductSize).toBe(2 * 1 * 2 * 2 * 1 * 1);
  });

  test("a mixed brief keeps every ratio — its non-motion ratios are the stills it asked for", () => {
    const result = fromBrief(motionOnly(["static", "motion"]), { motionRatios: ["9:16"] });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.mixStatic).toBe(true);
    expect(result.value.ratios).toEqual(["1:1", "9:16", "16:9"]);
  });

  test("a motion-only brief whose platforms package motion at no ratio is refused, not rendered as stills", () => {
    const result = fromBrief(motionOnly(["motion"]), { motionRatios: [] });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/requests only "motion" but none of output\.platforms package it/);
  });
});

});
