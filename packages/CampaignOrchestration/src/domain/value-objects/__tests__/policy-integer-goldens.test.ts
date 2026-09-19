import { describe, test, expect } from "vitest";
import { seedFrom } from "@campaignfoundry/shared";
import type { CampaignBrief } from "../../entities/CampaignBrief.js";
import type { Product } from "../../entities/Product.js";
import { BRIEF_SCHEMA_VERSION } from "../brief-schema-version.js";
import { DEFAULT_CAMPAIGN_TYPE } from "../campaign-types.js";
import { templateFromCanonical } from "../brief-template.js";
import { VariationPolicy } from "../VariationPolicy.vo.js";
import { nodeCryptoPolicyHasher } from "../../../infrastructure/index.js";

/**
 * **M3's "no number moved" pin.** Unifying where the five policy integers get
 * their defaults is worth nothing if it quietly changes one of them: a brief
 * that planned before must plan identically after — same count, same seed, same
 * distance, same floors.
 *
 * `policyHash` is sha256-hex over the canonical JSON of a payload that carries
 * **all five** (`count`, `seed`, `minDistance`, `coverage.perProduct`,
 * `coverage.perRatio`), so one literal per fixture pins every one of them at
 * once, and pins them as the *hash the planner records* rather than as five
 * numbers a reader could update together with the code. A re-roll compares
 * against this hash, so a moved default is also a re-roll that stops matching.
 *
 * **These literals are a PRE-CHANGE baseline**, recorded against the code at
 * `550a7746` (the merge-base) and then carried across the change unchanged —
 * not read off the new implementation. The file deliberately imports nothing
 * M3 introduced, so it runs against either side of the change and the recording
 * can be repeated: `git checkout 550a7746 -- <the three sources>` and run it.
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

const policyFor = (variation: CampaignBrief["variation"]) => {
  const result = VariationPolicy.fromBrief(brief(variation), {}, nodeCryptoPolicyHasher);
  if (!result.success) throw result.error;
  return result.value;
};

describe("policy integers — no number moved", () => {
  test("every integer absent: the derived seed, minDistance 1, both floors 0", () => {
    const policy = policyFor({ count: 12 });
    expect(policy.count).toBe(12);
    expect(policy.seed).toBe(seedFrom("golden"));
    expect(policy.minDistance).toBe(1);
    expect(policy.coverage).toEqual({ perProduct: 0, perRatio: 0 });
    expect(policy.policyHash).toBe(
      "771f9f751c49fe56b1ddeb6353bb7dcef5521e3786c5adce8a3ddc1181d0d42d",
    );
  });

  test("every integer written down, including the seed 0 that is not absence", () => {
    const policy = policyFor({
      count: 12,
      seed: 0,
      minDistance: 2,
      coverage: { perProduct: 1, perRatio: 3 },
    });
    expect(policy.count).toBe(12);
    expect(policy.seed).toBe(0);
    expect(policy.minDistance).toBe(2);
    expect(policy.coverage).toEqual({ perProduct: 1, perRatio: 3 });
    expect(policy.policyHash).toBe(
      "657d1baa805f1f127af891beb4b919361ea6073ef73f9b960393432af99975c7",
    );
  });

  test("an explicit coverage of zeroes plans EXACTLY as an absent coverage block", () => {
    // Not a second literal: the point is that the two hash to the same thing,
    // which is what "absent is the same as 0, for this field" means when the
    // planner is the one being asked.
    expect(policyFor({ count: 12, coverage: { perProduct: 0, perRatio: 0 } }).policyHash).toBe(
      policyFor({ count: 12 }).policyHash,
    );
  });

  test("an explicit minDistance of 1 plans EXACTLY as an absent minDistance", () => {
    expect(policyFor({ count: 12, minDistance: 1 }).policyHash).toBe(
      policyFor({ count: 12 }).policyHash,
    );
  });

  test("an explicit seed of 0 does NOT plan as an absent seed", () => {
    // The vacuity guard: if `seedFrom("golden")` were itself 0 this inequality
    // would prove nothing about seeds, so the fixture's derived seed is pinned
    // as non-zero first.
    expect(seedFrom("golden")).not.toBe(0);
    expect(policyFor({ count: 12, seed: 0 }).policyHash).not.toBe(
      policyFor({ count: 12 }).policyHash,
    );
  });
});
