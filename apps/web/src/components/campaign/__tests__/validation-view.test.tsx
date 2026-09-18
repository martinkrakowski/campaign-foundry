import { describe, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ValidationView } from "@/components/campaign/ValidationView";
import * as messages from "@/components/campaign/messages";
import { MOTION_LABEL } from "@/components/campaign/ErrorStrip";

/**
 * SG10 — the validation view at its own seam.
 *
 * The lane's behaviour is pinned end to end in `brief-editor.test.tsx`, where the
 * view is reachable by the control that reveals it and the gate it refreshes is
 * the real one. What is asserted HERE is the bucket→row mapping, which the editor
 * cannot reach from the outside: `motion` is the one error bucket that is not a
 * section (it validates inside its Output host), and an undeclared bucket is the
 * case the mapping is written to refuse rather than to spell as a raw key.
 */
describe("ValidationView — the bucket mapping", () => {
  const noop = () => {};

  /**
   * Motion has no section of its own — `SECTION_TITLES` cannot name it, which is
   * exactly why `ErrorStrip` declares `MOTION_LABEL` and why this view reads that
   * constant instead of spelling a third copy of the word. The label is asserted
   * against the declared constant, so a rename moves both together; the *rows* are
   * asserted as exact text, so a raw `[motion]` key leaking through would fail.
   *
   * The second bucket is not decoration: motion is also the one bucket whose
   * POSITION in the list is not its own. It validates inside its Output host, so it
   * sorts where Output sorts — after Copy in `sectionOrder("brief")` — and a
   * `walk.indexOf("motion")` that skipped the host mapping would return `-1` and
   * float it to the top, above every real section. One row could never show that.
   */
  test("a motion error wears its declared label and sorts at its host's position", () => {
    render(
      <ValidationView
        errors={{
          motion: { motion: "Pick a motion kind." },
          copy: { campaignMessage: "Headline is empty." },
        }}
        mode="brief"
        validated={false}
        onRevealSection={noop}
        onRevalidate={noop}
      />,
    );

    const panel = screen.getByTestId("column-validate");
    expect(within(panel).getByText(`[${MOTION_LABEL}]`)).toBeTruthy();
    expect(within(panel).queryByText("[motion]")).toBeNull();
    const rows = [...panel.querySelectorAll("[class*='text-text-primary']")].map(
      (el) => el.parentElement?.textContent,
    );
    expect(rows).toEqual(["[Copy] Headline is empty.", `[${MOTION_LABEL}] Pick a motion kind.`]);
  });

  /**
   * An undeclared bucket cannot occur — `error-key-coverage.test.ts` pins the map
   * against what `validateState` actually emits, both ways. So this is the
   * refusal, not a fallback: a key with no declared label is DROPPED rather than
   * rendered as `[somethingNew]`, which is the same answer `ErrorStrip` gives its
   * chips. Spelling an unknown key into a monospace report would put a token in
   * front of the operator that names nothing they can navigate to, and would make
   * the panel's Copy control emit it.
   *
   * The declared bucket beside it is what keeps this from passing on a component
   * that rendered nothing at all.
   */
  test("a bucket with no declared label is dropped, never spelled as a raw key", () => {
    render(
      <ValidationView
        errors={{
          somethingNew: { field: "A bucket nobody declared." },
          copy: { campaignMessage: "Headline is empty." },
        }}
        mode="brief"
        validated={false}
        onRevealSection={noop}
        onRevalidate={noop}
      />,
    );

    const panel = screen.getByTestId("column-validate");
    expect(within(panel).queryByText("[somethingNew]")).toBeNull();
    expect(within(panel).queryByText("A bucket nobody declared.")).toBeNull();
    expect(within(panel).getByText("[Copy]")).toBeTruthy();
    expect(within(panel).getByText("Headline is empty.")).toBeTruthy();
  });

  /**
   * The refresh control is the only way this component can ask for anything, and
   * it asks only when pressed. Rendering is not a press: there is no effect here
   * and no mount hook, which is red fault 3 stated at the component's own seam —
   * the editor-level test proves the consequence (Generate stays absent), this one
   * proves the mechanism (`onRevalidate` is never called by a render).
   */
  test("rendering calls nothing; the refresh press calls the one handler", async () => {
    const user = userEvent.setup();
    const onRevalidate = vi.fn();
    render(
      <ValidationView
        errors={{}}
        mode="brief"
        validated={false}
        onRevealSection={noop}
        onRevalidate={onRevalidate}
      />,
    );

    expect(onRevalidate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: messages.validationRefresh }));
    expect(onRevalidate).toHaveBeenCalledTimes(1);
  });
});
