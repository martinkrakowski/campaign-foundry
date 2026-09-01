import { createRef } from "react";
import type { ComponentProps } from "react";
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { StepHeader } from "../StepHeader";
import { initialEditorState, toBrief } from "../editor-state";
import type { EditorState } from "../editor-state";
import * as messages from "../messages";

const props = (over: Partial<ComponentProps<typeof StepHeader>> = {}): ComponentProps<typeof StepHeader> => ({
  step: 2,
  total: 6,
  title: "Identity",
  subtitle: messages.stepSubtitleIdentity,
  state: initialEditorState(),
  ...over,
});

const header = (over: Partial<ComponentProps<typeof StepHeader>> = {}) => render(<StepHeader {...props(over)} />);

/** A draft that has been applied and saved — the chip's settled green state. */
const savedAndApplied = (): EditorState => {
  // A draft with content: a saved *blank* brief is pristine (nothing was ever
  // written), and the chip renders nothing for that.
  const state = { ...initialEditorState(), campaignMessage: "Hi" };
  const brief = toBrief(state);
  return {
    ...state,
    appliedSnapshot: brief,
    source: { kind: "file", file: `${brief.id}.yaml`, loadedId: brief.id, savedSnapshot: brief, revision: undefined },
  };
};

describe("StepHeader", () => {
  test("the eyebrow reads the step position from the props, never a literal", () => {
    const { rerender } = header({ step: 2, total: 6 });
    expect(screen.getByText(messages.stepEyebrow(2, 6))).toBeTruthy();

    // A different total must move the text with it — a hardcoded "STEP 2 OF 6"
    // would survive everything else this suite can throw at it.
    rerender(<StepHeader {...props({ total: 9 })} />);
    expect(screen.getByText(messages.stepEyebrow(2, 9))).toBeTruthy();
    expect(screen.queryByText(messages.stepEyebrow(2, 6))).toBeNull();
  });

  test("the heading carries the step's title, at level 1", () => {
    header();
    expect(screen.getByRole("heading", { level: 1, name: "Identity" })).toBeTruthy();
  });

  test("the heading is focusable without tabbing: tabindex=-1", () => {
    header();
    expect(screen.getByRole("heading", { level: 1 }).getAttribute("tabindex")).toBe("-1");
  });

  test("headingRef is forwarded to the h1 — the step-change focus target", () => {
    const ref = createRef<HTMLHeadingElement>();
    header({ headingRef: ref });
    expect(ref.current).toBe(screen.getByRole("heading", { level: 1 }));
  });

  test("the subtitle line carries the step's subtitle", () => {
    header({ subtitle: messages.stepSubtitleCopy });
    expect(screen.getByText(messages.stepSubtitleCopy)).toBeTruthy();
  });

  test("the status chip reflects the editor state it is handed", () => {
    // The labels below are StatusChip's own two-state vocabulary (D41); what this
    // pins is the wiring — the `state` prop flows through to the chip, so a Guided
    // step head cannot freeze one chip state for every draft. A pristine state is
    // outside the two states entirely: with nothing in the draft, the chip renders
    // nothing at all.
    const typed = { ...initialEditorState(), campaignMessage: "Hi" };
    const { rerender } = header({ state: typed });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    rerender(<StepHeader {...props({ state: savedAndApplied() })} />);
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.queryByText("Unsaved changes")).toBeNull();

    rerender(<StepHeader {...props()} />);
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.queryByText("Saved")).toBeNull();
  });

  test("sticky is scoped to the column, not the viewport", () => {
    // happy-dom applies no CSS, so the class is the only observable: `sticky` on
    // the header's own root sticks it within the shell's main container (the
    // scroller), and the absence of `fixed` is what keeps it out of the viewport.
    const { container } = header();
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain("sticky");
    expect(root.className).toContain("top-0");
    expect(root.className).not.toContain("fixed");
  });
});
