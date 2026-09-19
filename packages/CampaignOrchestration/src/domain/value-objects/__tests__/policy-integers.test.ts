import { describe, test, expect } from "vitest";
import { seedFrom } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../entities/CampaignBrief.js";
import type { Product } from "../../entities/Product.js";
import { BRIEF_SCHEMA_VERSION } from "../brief-schema-version.js";
import { DEFAULT_CAMPAIGN_TYPE } from "../campaign-types.js";
import { templateFromCanonical } from "../brief-template.js";
import { VariationPolicy } from "../VariationPolicy.vo.js";
import {
  POLICY_INTEGERS,
  POLICY_MAX_ACTIVE_AXES,
  UINT32_MAX,
  type PolicyIntegerRule,
} from "../variation-defaults.js";
import { nodeCryptoPolicyHasher } from "../../../infrastructure/index.js";

/**
 * **M3 — each of the five policy integers states its own rule for absence and
 * for `0`, and each one is asserted on its own.**
 *
 * One test per field, deliberately not a `test.each` over the table: a group
 * assertion stays green while a single row drifts, and `vitest -t` cannot
 * single out a `%j`-titled case without a regex that happens to escape the
 * fixture's punctuation. Each test names the row it pins and then asserts the
 * behaviour that row is supposed to produce — so the table cannot be edited
 * into agreement with a broken implementation without a named test going red.
 *
 * The five do NOT agree, and are not supposed to. What the tests pin is that
 * each disagreement is the one the table declares.
 */

const product = (id: string): Product => ({
  id,
  name: id,
  primaryColor: "#1473E6",
  logoPath: `${id}.png`,
});

const brief = (variation: CampaignBrief["variation"]): CampaignBrief => ({
  schemaVersion: BRIEF_SCHEMA_VERSION,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "golden",
  targetRegion: "DE",
  targetAudience: "audience",
  campaignMessage: "Hello",
  products: [product("alpha"), product("beta")],
  mode: "variation",
  variation,
});

const plan = (variation: CampaignBrief["variation"]) =>
  VariationPolicy.fromBrief(brief(variation), {}, nodeCryptoPolicyHasher);

const planned = (variation: CampaignBrief["variation"]) => {
  const result = plan(variation);
  if (!result.success) throw result.error;
  return result.value;
};

describe("policy integers — one rule per field", () => {
  test("count: absent is REFUSED, there is no default, and 0 is below the floor", () => {
    expect(POLICY_INTEGERS.count.absent).toEqual({ kind: "required" });
    expect(POLICY_INTEGERS.count.min).toBe(1);

    // Absent: refused, naming the field. Not defaulted to anything — a
    // randomized campaign with no total is not a campaign with a total of 0.
    const absent = plan({});
    expect(absent.success).toBe(false);
    if (!absent.success) expect(absent.error.message).toBe('Variation policy requires "count".');

    // A brief with no `variation` block at all takes the same refusal.
    const noBlock = VariationPolicy.fromBrief(
      { ...brief({ count: 1 }), variation: undefined },
      {},
      nodeCryptoPolicyHasher,
    );
    expect(noBlock.success).toBe(false);
    if (!noBlock.success) expect(noBlock.error.message).toBe('Variation policy requires "count".');

    // 0 is not "absent spelled differently": it is a value below the floor.
    const zero = plan({ count: 0 });
    expect(zero.success).toBe(false);
    if (!zero.success) expect(zero.error.message).toBe("Invalid count.");

    expect(planned({ count: 1 }).count).toBe(1);
  });

  test("seed: absent is DERIVED from the brief id, and 0 is a legal, different seed", () => {
    expect(POLICY_INTEGERS.seed.absent).toEqual({ kind: "derived" });
    expect(POLICY_INTEGERS.seed.min).toBe(0);
    expect(POLICY_INTEGERS.seed.max).toBe(UINT32_MAX);

    // The one field where absence is neither a refusal nor a constant.
    expect(planned({ count: 12 }).seed).toBe(seedFrom("golden"));
    // Vacuity guard: the inequality below means nothing if the derived seed
    // happens to be 0 for this id.
    expect(seedFrom("golden")).not.toBe(0);
    // 0 is legal AND is not what absence means — the whole reason seed cannot
    // share `coverage`'s rule.
    expect(planned({ count: 12, seed: 0 }).seed).toBe(0);
    expect(planned({ count: 12, seed: 0 }).seed).not.toBe(planned({ count: 12 }).seed);

    // The uint32 bound the PRNG's state imposes, at both ends.
    expect(planned({ count: 12, seed: UINT32_MAX }).seed).toBe(UINT32_MAX);
    const over = plan({ count: 12, seed: UINT32_MAX + 1 });
    expect(over.success).toBe(false);
    if (!over.success) expect(over.error.message).toBe("Invalid seed.");
  });

  test("minDistance: absent means 1, an explicit 0 is REFUSED (SL-D6), max is dynamic", () => {
    expect(POLICY_INTEGERS.minDistance.absent).toEqual({ kind: "default", value: 1 });
    expect(POLICY_INTEGERS.minDistance.min).toBe(1);
    // The one rule whose upper bound no table can hold: it is this brief's own
    // count of active `DISTANCE_AXES`, supplied by the policy.
    expect(POLICY_INTEGERS.minDistance.max).toBe(POLICY_MAX_ACTIVE_AXES);

    expect(planned({ count: 12 }).minDistance).toBe(1);
    expect(planned({ count: 12, minDistance: 1 }).minDistance).toBe(1);

    // SL-D6: 0 is NOT absence here. At 0 the searches accept two variants at the
    // same point in the space, so the domain refuses the value outright rather
    // than reading it as the default. (`apps/api/server/lib/load-brief.ts` is
    // the one place that reads a STORED 0 as 1, so an old document still opens;
    // see its own test at `load-brief.test.ts`.)
    const zero = plan({ count: 12, minDistance: 0 });
    expect(zero.success).toBe(false);
    if (!zero.success) expect(zero.error.message).toBe("Invalid minDistance.");

    // The dynamic max is a real bound: this brief activates 6 of DISTANCE_AXES
    // (productId, aspectRatio, layout, tone, backgroundSource, paletteShift).
    expect(planned({ count: 12, minDistance: 6 }).minDistance).toBe(6);
    const over = plan({ count: 12, minDistance: 7 });
    expect(over.success).toBe(false);
    if (!over.success) expect(over.error.message).toBe("Invalid minDistance.");
  });

  test("coverage.perProduct: absent means 0, and 0 means the SAME thing — no floor", () => {
    expect(POLICY_INTEGERS.perProduct.absent).toEqual({ kind: "default", value: 0 });
    expect(POLICY_INTEGERS.perProduct.min).toBe(0);
    // The rule declares no upper bound at all — widened to the interface to ask
    // the question, since `as const satisfies` narrows the row to its own keys.
    expect((POLICY_INTEGERS.perProduct as PolicyIntegerRule).max).toBeUndefined();

    // Absent block, absent member, and an explicit 0: one value, three spellings.
    expect(planned({ count: 12 }).coverage.perProduct).toBe(0);
    expect(planned({ count: 12, coverage: { perRatio: 1 } }).coverage.perProduct).toBe(0);
    expect(planned({ count: 12, coverage: { perProduct: 0 } }).coverage.perProduct).toBe(0);
    expect(planned({ count: 12, coverage: { perProduct: 4 } }).coverage.perProduct).toBe(4);

    // Below the floor is refused, and is named by its dotted path.
    const negative = plan({ count: 12, coverage: { perProduct: -1 } });
    expect(negative.success).toBe(false);
    if (!negative.success) {
      expect(negative.error.message).toBe("Invalid coverage.perProduct.");
    }
  });

  test("coverage.perRatio: absent means 0, and 0 means the SAME thing — no floor", () => {
    expect(POLICY_INTEGERS.perRatio.absent).toEqual({ kind: "default", value: 0 });
    expect(POLICY_INTEGERS.perRatio.min).toBe(0);
    expect((POLICY_INTEGERS.perRatio as PolicyIntegerRule).max).toBeUndefined();

    expect(planned({ count: 12 }).coverage.perRatio).toBe(0);
    expect(planned({ count: 12, coverage: { perProduct: 1 } }).coverage.perRatio).toBe(0);
    expect(planned({ count: 12, coverage: { perRatio: 0 } }).coverage.perRatio).toBe(0);
    expect(planned({ count: 12, coverage: { perRatio: 4 } }).coverage.perRatio).toBe(4);

    const negative = plan({ count: 12, coverage: { perRatio: -1 } });
    expect(negative.success).toBe(false);
    if (!negative.success) {
      expect(negative.error.message).toBe("Invalid coverage.perRatio.");
    }
  });
});
