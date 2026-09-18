import { describe, test, expect } from "vitest";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { editorReducer, fromBrief, isValidationFresh, toBrief, valuesEqual } from "../editor-state";
import { getTotalErrorCount, validateState } from "../validate";

/**
 * SG-D15 / §8.4 — the validation gate's key, pinned as a pure predicate.
 *
 * The editor's own tests prove the wiring (the slot flips, the confirm runs the
 * projection). This file exists for the one thing a component test cannot state
 * plainly: WHY the key is the `state` reference and not the projection. §8.4 records
 * two rejected keys, and the projection is the one that still looks right.
 */

/**
 * A valid CLASSIC brief that declares `output`, so `outputExplicit` is set and the
 * `output` block is written whatever the toggle below does to it. Without that the
 * projection would grow the key on the first divergence and the comparison would
 * change for a reason that has nothing to do with the argument.
 */
const classicBrief = (): CampaignBrief =>
  ({
    schemaVersion: 1,
    template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
    id: "probe",
    targetRegion: "DE",
    targetAudience: "a",
    campaignMessage: "Hi",
    products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
    output: { formats: ["static"], platforms: ["instagram-feed"] },
  }) as CampaignBrief;

describe("isValidationFresh (SG-D15 / §8.4)", () => {
  test("a stored state is fresh against itself, and nothing is fresh before a validation", () => {
    const state = fromBrief(classicBrief());
    expect(isValidationFresh(state, state)).toBe(true);
    // No stored result is "unvalidated", the third row of §8.4's table — and it is the
    // starting condition, which is why Generate is absent on arrival (SG-D20).
    expect(isValidationFresh(null, state)).toBe(false);
  });

  test("an edit that changes validity while leaving the PROJECTION byte-identical still closes the gate", () => {
    const clean = fromBrief(classicBrief());
    expect(getTotalErrorCount(validateState(clean))).toBe(0);

    // Turn Video on in a CLASSIC draft. `serialisedFormats` strips `motion` on the way
    // out of a classic brief (D99), so `toBrief` cannot see this edit at all…
    const broken = editorReducer(clean, { type: "toggleFormat", value: "motion" });
    expect(valuesEqual(toBrief(clean), toBrief(broken))).toBe(true);

    // …while `validateState`, which reads `state.formats` directly, gains two errors:
    // Video needs a Randomized campaign, and no selected platform can take it.
    expect(getTotalErrorCount(validateState(broken))).toBe(2);

    // THIS is the assertion §8.4 exists for. Re-key the gate onto the projection —
    // `valuesEqual(toBrief(validatedState), toBrief(state))`, which mirrors
    // `isDirtySinceApply` and looks like the obvious refactor — and this line returns
    // true: the editor would report "still validated" and leave Generate live on a
    // document that had just become invalid, spending GenAI credits on a brief the
    // operator never approved. Reference equality cannot be fooled this way, because
    // the reducer returned a new object.
    expect(isValidationFresh(clean, broken)).toBe(false);
  });

  test("a no-op action the reducer refuses does NOT cost a good validation", () => {
    const state = fromBrief(classicBrief());
    // A flip to the mode that is already selected changed nothing, and the reducer says
    // so by returning the same object (`setMode`'s "keep the state identity-equal, the
    // way a refused action stays identity-equal"). The gate inherits that for free:
    // a rejected gesture is not an edit, so it must not send the operator back to
    // Validate. A boolean `isValidated` flag would have had to remember not to clear
    // itself here — which is §8.4's reason for refusing the flag.
    const again = editorReducer(state, { type: "setMode", mode: state.mode });
    expect(again).toBe(state);
    expect(isValidationFresh(state, again)).toBe(true);
  });

  test("a real edit flips the comparison, which is the owner's requirement verbatim", () => {
    const state = fromBrief(classicBrief());
    const edited = editorReducer(state, { type: "patch", patch: { campaignMessage: "Hi!" } });
    expect(edited).not.toBe(state);
    expect(isValidationFresh(state, edited)).toBe(false);
  });
});
