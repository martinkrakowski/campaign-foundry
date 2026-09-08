import { fireEvent, render } from "@testing-library/react";
import type { ReactElement } from "react";

/**
 * Drive a modal's focus trap through every branch: forward-Tab wrap from the last
 * focusable, backward-wrap from the first, and a non-Tab key (early return).
 */
export const exerciseFocusTrap = (dialog: HTMLElement) => {
  const focusables = [
    ...dialog.querySelectorAll<HTMLElement>('a[href], button, input, [tabindex]:not([tabindex="-1"])'),
  ];
  // Focus every element and tab both ways, so the forward-wrap (at the last element)
  // and backward-wrap (at the first) both fire regardless of selector ordering.
  for (const el of focusables) {
    el.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    el.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  }
  fireEvent.keyDown(window, { key: "x" }); // non-Tab, non-Escape → early return
};

/** The kit has no run context; a plain render is what kit tests actually need. */
export const renderWithRun = (ui: ReactElement) => render(ui);
