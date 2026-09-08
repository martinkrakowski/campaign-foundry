import { describe, test, expect } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun } from "@/__tests__/helpers";
import { ModelSelector } from "../ModelSelector";

/**
 * The control-boundary token (WCAG 1.4.11): a control whose fill differs from its
 * ground by ~1.05:1 is identified only by its hairline, so that hairline must be
 * `border-border-control` (≥ 3:1 on every ground), not `border-border`. jsdom applies
 * no CSS, so the class list is the only observable — and the exact token, split from
 * the class string, because `border-border` is a substring of `border-border-control`
 * and a substring assertion could never catch a regression back to the faint token.
 */
const classes = (el: Element): readonly string[] => el.className.split(/\s+/);

describe("control boundaries carry border-control", () => {
  test("ModelSelector — the trigger, and the row controls the modal opens", async () => {
    const user = userEvent.setup();
    renderWithRun(<ModelSelector />);
    const trigger = screen.getByTitle("Change image model");
    expect(classes(trigger)).toContain("border-border-control");
    expect(classes(trigger)).toContain("hover:border-border-control-hover");
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Select image model" });
    // The row buttons' fill is the modal's own `surface` — a 1:1 match — so the rule
    // between rows is the only edge a row has, and that is a control boundary. Same
    // exact-token split as above: `divide-border` is a substring of
    // `divide-border-control`, so only a split class list can see the regression.
    const list = dialog.querySelector(".divide-y") as HTMLElement;
    expect(classes(list)).toContain("divide-border-control");
    expect(classes(list)).not.toContain("divide-border");
  });
});
