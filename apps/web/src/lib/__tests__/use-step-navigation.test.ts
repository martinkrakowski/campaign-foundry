import { describe, test, expect, vi } from "vitest";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { stashStep, takeStashedStep, isTypingTarget } from "../use-step-navigation";

/**
 * SG1 — what is left of this file's suite.
 *
 * The walk's own describes (`useStepNavigation`, `useStepSwipe`, `useStepKeys`,
 * `useBecameTrue`, `swipeDirection`, `overlayIsOpen`, `STEP_TRANSITION_MS`) went
 * with the hooks they covered: the wizard is retired (SG-D2), so those tests
 * protected nothing a user could reach. What remains covers the two exports that
 * still have live callers.
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

describe("the step baton (H5)", () => {
  test("takeStashedStep spends the baton by reading it", () => {
    stashStep("copy");
    expect(takeStashedStep()).toBe("copy");
    expect(localStorage.getItem("cf:step-handoff")).toBeNull();
    expect(takeStashedStep()).toBeNull();
  });

  test("a storage that throws on write does not break the save that was stashing", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => stashStep("output")).not.toThrow();
    vi.restoreAllMocks();
  });

  test("a storage that throws on read answers with no baton at all", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(takeStashedStep()).toBeNull();
    vi.restoreAllMocks();
  });
});
