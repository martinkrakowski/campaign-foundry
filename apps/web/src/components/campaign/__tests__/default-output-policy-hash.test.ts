import { describe, test, expect } from "vitest";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { VariationPolicy } from "@campaignfoundry/CampaignOrchestration";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { initialEditorState, toBrief, STATIC_PLATFORMS, type EditorState } from "../editor-state";
// The same cross-app import ceiling-parity.test.ts makes, for the same reason:
// `motionRatiosFor` is what the API actually feeds the planner, so the domain
// here is driven by the brief the editor actually writes, end to end.
import { motionRatiosFor } from "../../../../../api/server/lib/platform-zones";

/**
 * M1 made `isDefaultOutput` read `sizes`, so a draft that previously omitted
 * `output` now emits it. `toBrief` is what Save sends and what Generate runs, and
 * a moved `policyHash` refuses a selective re-roll of existing creatives (the
 * defect #499 hit), so "does the block's arrival move the hash" is the question
 * this projection change has to answer rather than assume.
 *
 * It does not. The hash is taken over the RESOLVED policy, not the brief text
 * (`VariationPolicy.vo.ts`): `output.sizes` is read by nothing the hash covers,
 * `ratios` comes from `variation.axes.ratio`, and `motionRatios` — the one policy
 * field derived from `output.platforms` — joins the hashed object only under
 * `motionEnabled`, which a static-format brief never is.
 *
 * The hasher is the identity function on purpose: the "hash" is then the canonical
 * JSON the real sha256 would digest, so an equality here is equality of the hashed
 * input itself and a failure prints the field that moved instead of two hex strings.
 */
const identityHasher = (payload: string): string => payload;

const product = (over: Record<string, unknown> = {}) => ({
  key: 1,
  id: "alpha",
  name: "A",
  primaryColor: "#1473E6",
  logoPath: "l.png",
  inputAsset: "",
  idTouched: true,
  ...over,
});

// "variation" because a classic brief resolves no policy at all — there would be
// no hash to compare.
const draft = (over: Partial<EditorState> = {}): EditorState => ({
  ...initialEditorState("variation"),
  briefId: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  products: [product()],
  ...over,
});

/** The policy the API would resolve for this brief, with the motionRatios it derives. */
const policyOf = (brief: CampaignBrief): VariationPolicy => {
  const result = VariationPolicy.fromBrief(
    brief,
    motionRatiosFor(brief.output?.platforms),
    identityHasher,
  );
  if (!result.success) throw result.error;
  return result.value;
};

describe("emitting the output block for an authored size does not move policyHash", () => {
  const withSizes = draft({ sizes: ["728x90"] });
  const emitted = toBrief(withSizes);

  test("the block is emitted, and the only thing in it that is not the absent-key default is sizes", () => {
    // Guards the comparison below from vacuity: with the M1 term reverted there
    // is no block at all, both sides are the same brief, and equal hashes would
    // say nothing.
    expect(emitted.output).toBeDefined();
    expect(emitted.output?.sizes).toEqual(["728x90"]);
    expect(emitted.output?.formats).toEqual(["static"]);
    expect(emitted.output?.platforms).toEqual([...STATIC_PLATFORMS]);
  });

  test("the pre-M1 projection and the post-M1 one resolve the same policyHash", () => {
    const { output: _dropped, ...withoutOutput } = emitted;
    const before = withoutOutput as CampaignBrief;
    expect(before).not.toHaveProperty("output");

    // Not the same PlanInput on the two sides: an absent `output.platforms` lets
    // every ratio carry a clip, while the three static profiles package motion at
    // none. The hash is stable across that difference because a static brief does
    // not hash `motionRatios` at all — which is the property under test, so it is
    // asserted rather than left to the reader.
    expect(motionRatiosFor(before.output?.platforms)).toEqual({});
    expect(motionRatiosFor(emitted.output?.platforms)).toEqual({ motionRatios: [] });

    expect(policyOf(emitted).policyHash).toBe(policyOf(before).policyHash);
  });

  test("the hash still moves when the policy itself moves", () => {
    // The equality above must not be an artefact of a hasher that answers the
    // same thing for everything: a real policy change still shows.
    const moved = toBrief(
      draft({ sizes: ["728x90"], variation: { ...withSizes.variation, count: "13" } }),
    );
    expect(policyOf(moved).policyHash).not.toBe(policyOf(emitted).policyHash);
  });
});
