import { describe, test, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useStepNavigation } from "../use-step-navigation";

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
