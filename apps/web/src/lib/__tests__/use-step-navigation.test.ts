import { describe, test, expect } from "vitest";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { isTypingTarget } from "../use-step-navigation";

/**
 * SG1 / PT-5c1 — what is left of this file's suite.
 *
 * The walk's own describes (`useStepNavigation`, `useStepSwipe`, `useStepKeys`,
 * `useBecameTrue`, `swipeDirection`, `overlayIsOpen`, `STEP_TRANSITION_MS`) went
 * with the hooks they covered: the wizard is retired (SG-D2), so those tests
 * protected nothing a user could reach. The step baton's own describe
 * (`stashStep`/`takeStashedStep`) went with PT-5c1, which retired both call
 * sites. What remains covers the one export that still has a live caller.
 */

describe("isTypingTarget", () => {
  test("a field, and anything inside one, keeps its own keystrokes", () => {
    const { container } = render(
      createElement("div", null, [
        createElement("input", { key: "i", "data-testid": "input" }),
        createElement("textarea", { key: "t", "data-testid": "textarea" }),
        createElement("select", { key: "s", "data-testid": "select" }),
        createElement("div", { key: "c", "data-testid": "editable", contentEditable: true }),
        createElement("div", { key: "r", "data-testid": "textbox", role: "textbox" }),
        createElement("button", { key: "b", "data-testid": "button" }),
      ]),
    );
    for (const id of ["input", "textarea", "select", "editable", "textbox"]) {
      expect(isTypingTarget(container.querySelector(`[data-testid="${id}"]`))).toBe(true);
    }
    // A button is not a field, so an arrow key pressed on one is the walk's.
    expect(isTypingTarget(container.querySelector('[data-testid="button"]'))).toBe(false);
  });

  test("a key aimed at the window, the document, or nothing is not inside a field", () => {
    expect(isTypingTarget(window)).toBe(false);
    expect(isTypingTarget(document)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
