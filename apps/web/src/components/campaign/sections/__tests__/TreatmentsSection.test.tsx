import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TreatmentsSection } from "../TreatmentsSection";
import { initialEditorState, LAYOUT_OPTIONS, TONE_OPTIONS } from "../../editor-state";

/**
 * The control-boundary token (WCAG 1.4.11): a native <select> on bg-surface is
 * identified only by its hairline, so it must be `border-border-control` (≥ 3:1 on
 * every ground). jsdom applies no CSS, so the class list is the only observable —
 * split, because `border-border` is a substring of `border-border-control`.
 */
const classes = (el: Element): readonly string[] => el.className.split(/\s+/);

describe("TreatmentsSection", () => {
  test("the layout and tone selects keep the control-boundary hairline", () => {
    const state = initialEditorState();
    state.treatments = [{ id: "t1", layout: LAYOUT_OPTIONS[0], tone: TONE_OPTIONS[0] }];
    render(<TreatmentsSection state={state} dispatch={vi.fn()} errors={{}} />);

    for (const label of ["Layout", "Tone"]) {
      const select = screen.getByLabelText(label);
      expect(classes(select)).toContain("border-border-control");
      expect(classes(select)).not.toContain("border-border");
    }
  });

  test("renders nothing outside classic mode", () => {
    const state = initialEditorState("variation");
    const { container } = render(<TreatmentsSection state={state} dispatch={vi.fn()} errors={{}} />);
    expect(container.firstChild).toBeNull();
  });
});
