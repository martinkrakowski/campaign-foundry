import { describe, test, expect } from "vitest";
import { seedFrom } from "@campaignfoundry/shared";
import { VariationPolicy } from "@campaignfoundry/CampaignOrchestration";
import { POLICY_INTEGERS } from "@campaignfoundry/CampaignOrchestration/variation-defaults";
import { initialEditorState, toBrief, type EditorState } from "../editor-state";
import { validatePolicy } from "../validate";

/**
 * **M3 — the web and the domain agree about what `0` and "absent" mean, for
 * each of the five free-typed policy integers.**
 *
 * The finding this closes (SG5): `count`, `seed`, `minDistance`,
 * `coverage.perProduct` and `coverage.perRatio` each had their own `??` on each
 * side of the wire, so "lossless" held only via a domain default two packages
 * away. Both sides now read `POLICY_INTEGERS`; these tests are what stops the
 * table from being decoration.
 *
 * Every case drives BOTH from one input, the way `ceiling-parity.test.ts` does
 * (#499): a single `EditorState` with the field typed as a STRING the way an
 * operator types it, projected through the editor's own `toBrief`, and the
 * resulting brief handed to `VariationPolicy.fromBrief`. Nothing on the domain
 * side is asserted against a literal the editor also produced — the assertions
 * are "the planner resolved the number the field says", so a change to either
 * side's rule shows up as a disagreement rather than as two fixtures someone
 * updated together.
 *
 * One test per field, not one over the group: a group test stays green while a
 * single field drifts, which is exactly the failure M3 is made of.
 */

// The hash is irrelevant here — only the resolved integers are — so the hasher
// only has to exist.
const stubHasher = (payload: string): string => `len:${payload.length}`;

const product = () => ({
  key: 1,
  id: "alpha",
  name: "A",
  primaryColor: "#1473E6",
  logoPath: "l.png",
  inputAsset: "",
  idTouched: true,
});

const BRIEF_ID = "camp";

/** A variation draft with every policy field blank, so each test types only its own. */
const draft = (variation: Partial<EditorState["variation"]> = {}): EditorState => {
  const base = initialEditorState("variation");
  return {
    ...base,
    briefId: BRIEF_ID,
    targetRegion: "DE",
    targetAudience: "a",
    campaignMessage: "Hi",
    products: [product()],
    variation: {
      ...base.variation,
      count: "12",
      seed: "",
      minDistance: "",
      perProduct: "",
      perRatio: "",
      ...variation,
    },
  };
};

/** The policy the planner actually resolves for the brief this draft saves. */
const planned = (state: EditorState) => {
  const result = VariationPolicy.fromBrief(toBrief(state), {}, stubHasher);
  if (!result.success) throw result.error;
  return result.value;
};

const refusal = (state: EditorState): string => {
  const result = VariationPolicy.fromBrief(toBrief(state), {}, stubHasher);
  expect(result.success).toBe(false);
  return result.success ? "" : result.error.message;
};

describe("policy integers — the editor and the planner agree", () => {
  test("count: the editor has no spelling for absence, and a refused draft stays refused", () => {
    // The rule: `absent: { kind: "required" }`. There is no key to omit, so the
    // editor cannot say "absent" — and it must not say "0 is fine" either.
    expect(POLICY_INTEGERS.count.absent).toEqual({ kind: "required" });

    expect(planned(draft({ count: "12" })).count).toBe(12);
    expect(planned(draft({ count: "1" })).count).toBe(1);

    // A blank draft, and a draft the shared parser refuses. Both serialise as
    // one below the floor, which the planner refuses — the refusal the operator
    // is already looking at travels with the brief instead of being laundered
    // into a legal number. The previous `?? 0` happened to spell the same
    // number; what changed is that it is now the floor's own neighbour rather
    // than a literal that could drift away from it.
    for (const typed of ["", "42.0", "12abc"]) {
      const state = draft({ count: typed });
      expect(toBrief(state).variation?.count).toBe(POLICY_INTEGERS.count.min - 1);
      expect(refusal(state)).toBe("Invalid count.");
      expect(validatePolicy(state).count).toBeDefined();
    }

    // A typed 0 is refused on both sides too — it is a value below the floor,
    // not a way of leaving the field out.
    expect(refusal(draft({ count: "0" }))).toBe("Invalid count.");
    expect(validatePolicy(draft({ count: "0" })).count).toBeDefined();
  });

  test("seed: a blank field is the DERIVED seed, and a typed 0 is the seed zero", () => {
    expect(POLICY_INTEGERS.seed.absent).toEqual({ kind: "derived" });

    // Blank → no key → the domain derives it from the brief id. The editor does
    // not know this number and must not invent one; it leaves the key out and
    // the domain answers.
    expect(toBrief(draft()).variation?.seed).toBeUndefined();
    expect(planned(draft()).seed).toBe(seedFrom(BRIEF_ID));

    // Vacuity guard: without this the inequality below would hold for a reason
    // that has nothing to do with seeds.
    expect(seedFrom(BRIEF_ID)).not.toBe(0);

    // A typed 0 is written, and is a different plan from the blank field. This
    // is the field where treating 0 as absence would silently re-seed the draw.
    expect(toBrief(draft({ seed: "0" })).variation?.seed).toBe(0);
    expect(planned(draft({ seed: "0" })).seed).toBe(0);
    expect(planned(draft({ seed: "0" })).seed).not.toBe(planned(draft()).seed);

    expect(planned(draft({ seed: "4294967295" })).seed).toBe(4294967295);
    expect(planned(draft({ seed: "7" })).seed).toBe(7);
  });

  test("minDistance: a blank field is 1, and a typed 1 is still WRITTEN (SL-D6 intact)", () => {
    expect(POLICY_INTEGERS.minDistance.absent).toEqual({ kind: "default", value: 1 });

    expect(toBrief(draft()).variation?.minDistance).toBeUndefined();
    expect(planned(draft()).minDistance).toBe(1);

    // The editor does NOT drop a value equal to the default here, unlike the
    // coverage pair: `minDistance` is a top-level key an operator authored, and
    // dropping a stored 1 on save would rewrite every document that carries one.
    expect(POLICY_INTEGERS.minDistance.omitWhenDefault).toBe(false);
    expect(toBrief(draft({ minDistance: "1" })).variation?.minDistance).toBe(1);
    expect(planned(draft({ minDistance: "1" })).minDistance).toBe(1);

    expect(planned(draft({ minDistance: "3" })).minDistance).toBe(3);

    // SL-D6: 0 is refused by the domain, and the editor says so too. The editor
    // writes the 0 rather than swallowing it — the API loader is the one place
    // a 0 is read as 1, and that is a decision about STORED documents.
    expect(toBrief(draft({ minDistance: "0" })).variation?.minDistance).toBe(0);
    expect(refusal(draft({ minDistance: "0" }))).toBe("Invalid minDistance.");
    expect(validatePolicy(draft({ minDistance: "0" })).minDistance).toBeDefined();
  });

  test("coverage.perProduct: blank and a typed 0 both mean no floor, and both omit the key", () => {
    expect(POLICY_INTEGERS.perProduct.absent).toEqual({ kind: "default", value: 0 });
    expect(POLICY_INTEGERS.perProduct.omitWhenDefault).toBe(true);

    // The only field pair where 0 IS absence — so the editor writes neither,
    // and an all-default block never grows the document.
    expect(toBrief(draft()).variation?.coverage).toBeUndefined();
    expect(toBrief(draft({ perProduct: "0" })).variation?.coverage).toBeUndefined();
    expect(planned(draft()).coverage.perProduct).toBe(0);
    expect(planned(draft({ perProduct: "0" })).coverage.perProduct).toBe(0);

    expect(toBrief(draft({ perProduct: "2" })).variation?.coverage).toEqual({ perProduct: 2 });
    expect(planned(draft({ perProduct: "2" })).coverage.perProduct).toBe(2);

    // A NEGATIVE floor is not the default and is not dropped: it is written, and
    // the planner refuses it, so the refusal the editor is already showing is
    // the one the plan preview shows too. The old `> 0` rule swallowed it and
    // handed the planner a legal floor of 0 instead.
    expect(toBrief(draft({ perProduct: "-3" })).variation?.coverage).toEqual({ perProduct: -3 });
    expect(refusal(draft({ perProduct: "-3" }))).toBe("Invalid coverage.perProduct.");
    expect(validatePolicy(draft({ perProduct: "-3" })).perProduct).toBeDefined();
  });

  test("coverage.perRatio: blank and a typed 0 both mean no floor, and both omit the key", () => {
    expect(POLICY_INTEGERS.perRatio.absent).toEqual({ kind: "default", value: 0 });
    expect(POLICY_INTEGERS.perRatio.omitWhenDefault).toBe(true);

    expect(toBrief(draft()).variation?.coverage).toBeUndefined();
    expect(toBrief(draft({ perRatio: "0" })).variation?.coverage).toBeUndefined();
    expect(planned(draft()).coverage.perRatio).toBe(0);
    expect(planned(draft({ perRatio: "0" })).coverage.perRatio).toBe(0);

    // perRatio × the ratios drawn must fit the count, so 4 on a 12-count,
    // three-ratio draft is the largest floor the editor also accepts.
    expect(toBrief(draft({ perRatio: "4" })).variation?.coverage).toEqual({ perRatio: 4 });
    expect(planned(draft({ perRatio: "4" })).coverage.perRatio).toBe(4);

    expect(toBrief(draft({ perRatio: "-3" })).variation?.coverage).toEqual({ perRatio: -3 });
    expect(refusal(draft({ perRatio: "-3" }))).toBe("Invalid coverage.perRatio.");
    expect(validatePolicy(draft({ perRatio: "-3" })).perRatio).toBeDefined();
  });

  test("the editor's seed bound is the table's, not a private copy of it", () => {
    // `validate.ts` keeps its own `UINT32_MAX`; this pins it to the rule
    // behaviourally rather than by import, so the two cannot drift into an
    // editor that accepts a seed the planner refuses.
    const max = POLICY_INTEGERS.seed.max;
    expect(typeof max).toBe("number");
    const atMax = String(max);
    const overMax = String((max as number) + 1);
    expect(validatePolicy(draft({ seed: atMax })).seed).toBeUndefined();
    expect(planned(draft({ seed: atMax })).seed).toBe(max);
    expect(validatePolicy(draft({ seed: overMax })).seed).toBeDefined();
    expect(refusal(draft({ seed: overMax }))).toBe("Invalid seed.");
  });
});
