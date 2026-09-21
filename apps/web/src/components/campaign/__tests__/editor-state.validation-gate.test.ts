import { describe, test, expect } from "vitest";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import {
  editorReducer,
  fromBrief,
  isValidationFresh,
  toBrief,
  valuesEqual,
  type EditorState,
} from "../editor-state";
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

/** The listing the validation was judged against, when the test is not about ids. */
const judged = (state: EditorState, existingIds: readonly string[] = []) => ({
  state,
  existingIds,
});

describe("isValidationFresh (SG-D15 / §8.4)", () => {
  test("a stored state is fresh against itself, and nothing is fresh before a validation", () => {
    const state = fromBrief(classicBrief());
    expect(isValidationFresh(judged(state), state, [])).toBe(true);
    // No stored result is "unvalidated", the third row of §8.4's table — and it is the
    // starting condition, which is why Generate is absent on arrival (SG-D20).
    expect(isValidationFresh(null, state, [])).toBe(false);
  });

  test("an edit that changes validity while leaving the PROJECTION byte-identical still closes the gate", () => {
    const clean = fromBrief(classicBrief());
    expect(getTotalErrorCount(validateState(clean))).toBe(0);

    // Turn Video on in a CLASSIC draft. **PD4: the operator route here is the MODE
    // FLIP, not the card.** Nobody reaches this state by pressing Video on a classic
    // draft — the card is not offered there. They build a Randomized draft with Video
    // on and then flip the mode back to Classic, which leaves `state.formats` carrying
    // `motion` under a campaign that cannot run it. Stated because a reader who thinks
    // the card is the route concludes this state is unreachable and deletes the test.
    // `serialisedFormats` strips `motion` on the way out of a classic brief (D99), so
    // `toBrief` cannot see this edit at all…
    const broken = editorReducer(clean, { type: "toggleFormat", value: "motion" });
    expect(valuesEqual(toBrief(clean), toBrief(broken))).toBe(true);

    // …while `validateState`, which reads `state.formats` directly, gains two errors:
    // Video needs a Randomized campaign, and no selected platform can take it.
    expect(getTotalErrorCount(validateState(broken))).toBe(2);

    // THIS is the assertion §8.4 exists for. Re-key the gate onto the projection —
    // `valuesEqual(toBrief(validation.state), toBrief(state))`, which mirrors
    // `isDirtySinceApply` and looks like the obvious refactor — and this line returns
    // true: the editor would report "still validated" and leave Generate live on a
    // document that had just become invalid, spending GenAI credits on a brief the
    // operator never approved. Reference equality cannot be fooled this way, because
    // the reducer returned a new object.
    //
    // The SAME id list is passed on both sides, deliberately: the listing term must
    // not be what saves this case, or the document term could be deleted unnoticed.
    expect(isValidationFresh(judged(clean, ["probe"]), broken, ["probe"])).toBe(false);
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
    expect(isValidationFresh(judged(state), again, [])).toBe(true);
  });

  test("a real edit flips the comparison, which is the owner's requirement verbatim", () => {
    const state = fromBrief(classicBrief());
    const edited = editorReducer(state, { type: "patch", patch: { campaignMessage: "Hi!" } });
    expect(edited).not.toBe(state);
    expect(isValidationFresh(judged(state), edited, [])).toBe(false);
  });

  test("the brief listing is the validation's other input, so moving it closes the gate", () => {
    const state = fromBrief(classicBrief());
    // `validateState(state, existingIds)` reads BOTH. The document has not moved here —
    // same object, so §8.4's key answers "fresh" — and yet the verdict it stands on can
    // no longer be trusted: the listing refetches on window focus, and an id that was
    // free when the brief was judged can be taken by the time Generate is pressed.
    expect(isValidationFresh(judged(state, ["other"]), state, ["other", "probe"])).toBe(false);
    // Both directions: an id disappearing is a moved listing too.
    expect(isValidationFresh(judged(state, ["other", "probe"]), state, ["other"])).toBe(false);
  });

  test("a listing refetch that changed nothing leaves a good validation standing", () => {
    const state = fromBrief(classicBrief());
    // THE trap, and the reason this comparison is by value. `existingIds` is
    // `briefs.map(…)` in the editor — a NEW array on every render, and a new one again
    // after every focus refetch. Key the listing half on identity the way the document
    // half is keyed, and the gate never opens at all: Generate would vanish on the next
    // render after the press. These two arrays are `!==` and must read as fresh.
    const judgedAgainst = ["alpha", "beta"];
    const refetched = ["alpha", "beta"];
    expect(judgedAgainst).not.toBe(refetched);
    expect(isValidationFresh(judged(state, judgedAgainst), state, refetched)).toBe(true);
    // The listing is a SET of ids: the same briefs in another order changed nothing a
    // validation read, and an ordering the server picked is not the operator's edit.
    expect(isValidationFresh(judged(state, judgedAgainst), state, ["beta", "alpha"])).toBe(true);
    // Not merely counting: two ids swapped for two others is not "nothing changed".
    expect(isValidationFresh(judged(state, judgedAgainst), state, ["gamma", "delta"])).toBe(false);
  });

  test("the capability probe answering twice with the same verdict is not an edit", () => {
    // The listing is not the only thing a window focus refetches: the capability probe
    // does too, and its answer lands as a `setCapabilities` dispatch every time. The
    // reducer returns the SAME object when the verdict has not moved, so an alt-tab
    // away and back does not cost the operator their validation — without that guard
    // the document half of the key would flip on every focus and the gate would shut
    // for a probe that said exactly what it said before.
    const state = editorReducer(fromBrief(classicBrief()), {
      type: "setCapabilities",
      capabilities: { motion: false, reason: "no ffmpeg" },
    });
    const again = editorReducer(state, {
      type: "setCapabilities",
      capabilities: { motion: false, reason: "no ffmpeg" },
    });
    expect(again).toBe(state);
    expect(isValidationFresh(judged(state), again, [])).toBe(true);

    // A verdict that really moved is an edit, and must close the gate: ffmpeg
    // appearing changes what the draft can do.
    const moved = editorReducer(state, {
      type: "setCapabilities",
      capabilities: { motion: true },
    });
    expect(moved).not.toBe(state);
    expect(isValidationFresh(judged(state), moved, [])).toBe(false);
  });
});
