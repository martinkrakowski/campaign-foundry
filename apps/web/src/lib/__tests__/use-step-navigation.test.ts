import { describe, test, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderHook, act, render, fireEvent, screen } from "@testing-library/react";
import {
  useStepNavigation,
  useStepSwipe,
  useStepKeys,
  useBecameTrue,
  isTypingTarget,
  overlayIsOpen,
  swipeDirection,
  STEP_TRANSITION_MS,
} from "../use-step-navigation";

/** The two modes' step lists are 6 either way; use a double-shaped list to exercise clamps. */
const steps = ["identity", "copy", "products", "treatments", "output", "review"];

const hook = () => renderHook(() => useStepNavigation(steps));

describe("useStepNavigation", () => {
  test("starts on the first step, no direction, nothing visited", () => {
    const { result } = hook();
    expect(result.current.index).toBe(0);
    expect(result.current.direction).toBe(1);
    expect(result.current.maxVisited).toBe(0);
    expect(result.current.go).toBeTypeOf("function");
  });

  test("going forward records the move and grows maxVisited", () => {
    const { result } = hook();
    act(() => result.current.go(2));
    expect(result.current.index).toBe(2);
    expect(result.current.direction).toBe(1);
    expect(result.current.maxVisited).toBe(2);
  });

  test("going back flips direction and never shrinks maxVisited", () => {
    const { result } = hook();
    act(() => result.current.go(3));
    act(() => result.current.go(1));
    expect(result.current.index).toBe(1);
    expect(result.current.direction).toBe(-1);
    expect(result.current.maxVisited).toBe(3);
  });

  test("a step already visited leaves maxVisited alone", () => {
    const { result } = hook();
    act(() => result.current.go(4));
    act(() => result.current.go(2));
    act(() => result.current.go(3));
    expect(result.current.maxVisited).toBe(4);
  });

  test("a request before the list clamps to the first step", () => {
    const { result } = hook();
    act(() => result.current.go(-7));
    expect(result.current.index).toBe(0);
  });

  test("a request past the list clamps to the last step", () => {
    const { result } = hook();
    act(() => result.current.go(99));
    expect(result.current.index).toBe(steps.length - 1);
    expect(result.current.maxVisited).toBe(steps.length - 1);
  });

  test("a request for the current step is a no-op move", () => {
    const { result } = hook();
    act(() => result.current.go(1));
    const visited = result.current.maxVisited;
    act(() => result.current.go(1));
    expect(result.current.index).toBe(1);
    expect(result.current.direction).toBe(-1);
    expect(result.current.maxVisited).toBe(visited);
  });

  test("a shortened list clamps the cursor and the visited mark into it", () => {
    const { result, rerender } = renderHook(
      (list: readonly string[]) => useStepNavigation(list),
      { initialProps: steps },
    );
    act(() => result.current.go(5));
    expect(result.current.index).toBe(5);

    // A mode flip replaces the list with one the cursor is past the end of.
    rerender(["identity", "copy", "products"]);
    expect(result.current.index).toBe(2);
    expect(result.current.maxVisited).toBe(2);

    // …and a move from there stays inside the shorter list.
    act(() => result.current.go(9));
    expect(result.current.index).toBe(2);
  });

  // The two real lists disagree at the same ordinal: classic is
  // [identity, copy, products, treatments, output, review] and randomized is
  // [identity, copy, products, output, policy, review]. Index 4 is `output` in one
  // and `policy` in the other, so a positional cursor moves the user without asking.
  const CLASSIC = ["identity", "copy", "products", "treatments", "output", "review"];
  const RANDOMIZED = ["identity", "copy", "products", "output", "policy", "review"];

  test("a mode flip keeps the user on the same step, not the same index", () => {
    const { result, rerender } = renderHook(
      (list: readonly string[]) => useStepNavigation(list),
      { initialProps: CLASSIC as readonly string[] },
    );
    act(() => result.current.go(4)); // `output` in classic
    expect(CLASSIC[result.current.index]).toBe("output");

    rerender(RANDOMIZED);

    // Index 4 is now `policy`. Following the id instead lands on 3, still `output`.
    expect(result.current.index).toBe(3);
    expect(RANDOMIZED[result.current.index]).toBe("output");
  });

  test("a step the flip really removes falls back to the remembered ordinal", () => {
    const { result, rerender } = renderHook(
      (list: readonly string[]) => useStepNavigation(list),
      { initialProps: CLASSIC as readonly string[] },
    );
    act(() => result.current.go(3)); // `treatments` — randomized has no such step
    expect(CLASSIC[result.current.index]).toBe("treatments");

    rerender(RANDOMIZED);

    // Nothing to follow, so the ordinal stands: index 3, which is `output` there.
    expect(result.current.index).toBe(3);
    expect(RANDOMIZED[result.current.index]).toBe("output");
  });
});

/* ── The step gestures (W7.3) ─────────────────────────────────────────────── */

describe("swipeDirection", () => {
  test("a tap, and anything under the floor, is not a swipe", () => {
    expect(swipeDirection(0, 0)).toBe(0);
    expect(swipeDirection(-59, 0)).toBe(0);
    expect(swipeDirection(59, 4)).toBe(0);
  });

  test("dragging left pulls the next step in; dragging right goes back", () => {
    expect(swipeDirection(-60, 0)).toBe(1);
    expect(swipeDirection(60, 0)).toBe(-1);
  });

  test("a mostly vertical drag is a scroll, however far it travels", () => {
    // 120px sideways but 100px down: 1.4 × 100 > 120, so the page must not turn.
    expect(swipeDirection(-120, 100)).toBe(0);
    expect(swipeDirection(-120, 60)).toBe(1);
    // Exactly at the ratio reads as a swipe: the floor is "at least this sideways".
    expect(swipeDirection(-140, 100)).toBe(1);
  });
});

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

describe("overlayIsOpen", () => {
  test("no overlay, no answer to give the arrow keys", () => {
    render(createElement("div", { "data-testid": "plain" }));
    expect(overlayIsOpen()).toBe(false);
  });

  test("a modal on screen is a modal that is mounted: dialogs and drawers both", () => {
    render(
      createElement("div", { "data-testid": "dialog", role: "dialog", "aria-modal": "true" }),
    );
    expect(overlayIsOpen()).toBe(true);
  });

  test("a dialog that is not modal does not own the keys of the page beneath it", () => {
    render(createElement("div", { "data-testid": "dialog", role: "dialog" }));
    expect(overlayIsOpen()).toBe(false);
  });
});

/** The card a finger moves. `useStepSwipe` hands back the pair it is spread onto. */
function SwipeCard({
  onSwipe,
  withField = false,
}: {
  onSwipe: (step: -1 | 1) => void;
  withField?: boolean;
}) {
  const swipe = useStepSwipe(onSwipe);
  return createElement(
    "div",
    { "data-testid": "card", onTouchStart: swipe.onTouchStart, onTouchEnd: swipe.onTouchEnd },
    withField ? createElement("input", { "data-testid": "field" }) : null,
  );
}

const touch = (el: HTMLElement, name: "touchStart" | "touchEnd", x: number, y: number) =>
  fireEvent[name](el, { changedTouches: [{ clientX: x, clientY: y }] });

describe("useStepSwipe", () => {
  test("a swipe across the card moves the walk, and a tap does not", () => {
    const onSwipe = vi.fn();
    render(createElement(SwipeCard, { onSwipe }));
    const card = screen.getByTestId("card");

    // A tap: 12px of drift is not a gesture anyone made on purpose.
    touch(card, "touchStart", 200, 300);
    touch(card, "touchEnd", 188, 302);
    expect(onSwipe).not.toHaveBeenCalled();

    touch(card, "touchStart", 200, 300);
    touch(card, "touchEnd", 80, 310);
    expect(onSwipe).toHaveBeenCalledWith(1);

    touch(card, "touchStart", 80, 300);
    touch(card, "touchEnd", 200, 290);
    expect(onSwipe).toHaveBeenCalledWith(-1);
  });

  test("a gesture that begins on a field belongs to that field", () => {
    const onSwipe = vi.fn();
    render(createElement(SwipeCard, { onSwipe, withField: true }));
    // A horizontal drag on a slider is the slider — 200px of it is still the slider.
    touch(screen.getByTestId("field"), "touchStart", 300, 100);
    touch(screen.getByTestId("card"), "touchEnd", 100, 105);
    expect(onSwipe).not.toHaveBeenCalled();
  });

  test("a spent start cannot be spent twice, and an overlay swallows the gesture", () => {
    const onSwipe = vi.fn();
    render(createElement(SwipeCard, { onSwipe }));
    const card = screen.getByTestId("card");

    // An end with no start behind it is not half a swipe.
    touch(card, "touchEnd", 100, 100);
    expect(onSwipe).not.toHaveBeenCalled();

    touch(card, "touchStart", 200, 100);
    touch(card, "touchEnd", 100, 100);
    touch(card, "touchEnd", 300, 100);
    expect(onSwipe).toHaveBeenCalledTimes(1);

    // A drawer is open: the drag belongs to whatever is in the drawer.
    render(createElement("div", { role: "dialog", "aria-modal": "true" }));
    touch(card, "touchStart", 200, 100);
    touch(card, "touchEnd", 100, 100);
    expect(onSwipe).toHaveBeenCalledTimes(1);
  });
});

/** The page the walk is listening on. `useStepKeys` binds to the window, not a node. */
function KeyPage({ enabled, onStep, withField = false }: {
  enabled: boolean;
  onStep: (step: -1 | 1) => void;
  withField?: boolean;
}) {
  useStepKeys({ enabled, onStep });
  return createElement("div", null, withField ? createElement("input", { "aria-label": "field" }) : null);
}

describe("useStepKeys", () => {
  test("the left and right arrows move the walk", () => {
    const onStep = vi.fn();
    render(createElement(KeyPage, { enabled: true, onStep }));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onStep.mock.calls).toEqual([[1], [-1]]);
  });

  test("the walk is not listening outside the guided presentation", () => {
    const onStep = vi.fn();
    render(createElement(KeyPage, { enabled: false, onStep }));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onStep).not.toHaveBeenCalled();
  });

  test("a left arrow inside a text field moves the caret, not the step", () => {
    const onStep = vi.fn();
    render(createElement(KeyPage, { enabled: true, onStep, withField: true }));
    fireEvent.keyDown(screen.getByLabelText("field"), { key: "ArrowLeft" });
    expect(onStep).not.toHaveBeenCalled();
    // …and the same key on the page itself still walks, so the suppression is
    // about where the key landed, not about the field existing.
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(onStep).toHaveBeenCalledWith(-1);
  });

  test("an arrow key while a dialog is up belongs to the dialog", () => {
    const onStep = vi.fn();
    render(createElement(KeyPage, { enabled: true, onStep }));
    render(createElement("div", { role: "dialog", "aria-modal": "true" }));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(onStep).not.toHaveBeenCalled();
  });

  test("any other key, and any chord, is left for whatever wanted it", () => {
    const onStep = vi.fn();
    render(createElement(KeyPage, { enabled: true, onStep }));
    // Up and Down scroll the column; Cmd+Left is the browser's own Back.
    fireEvent.keyDown(window, { key: "ArrowUp" });
    fireEvent.keyDown(window, { key: "a" });
    fireEvent.keyDown(window, { key: "ArrowRight", metaKey: true });
    expect(onStep).not.toHaveBeenCalled();
  });

  test("a key something else already handled is not taken a second time", () => {
    const onStep = vi.fn();
    render(createElement(KeyPage, { enabled: true, onStep }));
    const event = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true });
    event.preventDefault();
    act(() => void window.dispatchEvent(event));
    expect(onStep).not.toHaveBeenCalled();
  });

  test("the walk spends the key it answers, so nothing downstream sees it too", () => {
    render(createElement(KeyPage, { enabled: true, onStep: () => {} }));
    const event = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true });
    act(() => void window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
  });
});

/* ── The ready ring (W7.4) ────────────────────────────────────────────────── */

describe("useBecameTrue", () => {
  test("nothing has become anything on the first pass", () => {
    const { result } = renderHook(() => useBecameTrue(true, "identity"));
    expect(result.current).toBe(0);
  });

  test("counts the transitions into true within one subject, and nothing else", () => {
    const { result, rerender } = renderHook(({ valid, step }) => useBecameTrue(valid, step), {
      initialProps: { valid: false, step: "identity" },
    });
    // Fires on the transition…
    rerender({ valid: true, step: "identity" });
    expect(result.current).toBe(1);
    // …and not on any render that merely stays there — which is what keeps the
    // ring off every keystroke of a step that is already complete.
    rerender({ valid: true, step: "identity" });
    expect(result.current).toBe(1);
    // Leaving is not an event either.
    rerender({ valid: false, step: "identity" });
    expect(result.current).toBe(1);
    // …but arriving again is.
    rerender({ valid: true, step: "identity" });
    expect(result.current).toBe(2);
  });

  test("a new subject starts fresh: arriving somewhere already true is not an event", () => {
    const { result, rerender } = renderHook(({ valid, step }) => useBecameTrue(valid, step), {
      initialProps: { valid: false, step: "identity" },
    });
    // The step standing in the way is walked away from, and the next one is already
    // complete: the ring is for a step that became complete, not one that was.
    rerender({ valid: true, step: "copy" });
    expect(result.current).toBe(0);
    // The same step, while the visitor is standing on it, is a different matter.
    rerender({ valid: false, step: "copy" });
    rerender({ valid: true, step: "copy" });
    expect(result.current).toBe(1);
    // …and leaving hands the caller a zero again, so the ring comes off the button
    // rather than lingering on the next step.
    rerender({ valid: true, step: "products" });
    expect(result.current).toBe(0);
  });
});

describe("STEP_TRANSITION_MS", () => {
  test("is one --duration-normal, the token the exit animation it waits for reads", () => {
    const tokens = readFileSync(resolve(__dirname, "../../styles/tokens.css"), "utf-8");
    expect(tokens).toContain(`--duration-normal: ${STEP_TRANSITION_MS}ms;`);
  });
});
