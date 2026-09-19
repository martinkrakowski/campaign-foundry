import { describe, test, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useLatestOnly } from "../use-latest-only";

describe("useLatestOnly", () => {
  test("a token stays current until a new round begins", () => {
    const { result } = renderHook(() => useLatestOnly());
    const first = result.current.begin();
    expect(result.current.isCurrent(first)).toBe(true);
    const second = result.current.begin();
    expect(result.current.isCurrent(second)).toBe(true);
    // The whole point: the older round is now refusable.
    expect(result.current.isCurrent(first)).toBe(false);
  });

  /**
   * `current()` is what `HeadlinePoolDrawer`'s `apply` needs: it rides the load's
   * round rather than starting one. Calling `begin()` there would make the
   * in-flight load's own answer stale — the write would invalidate the very
   * thing it is writing against — so the two must not be the same call.
   */
  test("current() reads the round without starting one", () => {
    const { result } = renderHook(() => useLatestOnly());
    const started = result.current.begin();
    const ridden = result.current.current();
    expect(ridden).toBe(started);
    // Reading did not advance anything: the starter's token still holds.
    expect(result.current.isCurrent(started)).toBe(true);
    expect(result.current.isCurrent(ridden)).toBe(true);
  });

  test("before any round begins, current() is a token that is current", () => {
    const { result } = renderHook(() => useLatestOnly());
    const zero = result.current.current();
    expect(result.current.isCurrent(zero)).toBe(true);
  });

  /**
   * The identity contract. `apply` closes over these across an `await`, and a
   * per-render identity would make them a dependency nobody can name.
   */
  test("the api identity is stable across re-renders", () => {
    const { result, rerender } = renderHook(() => useLatestOnly());
    const before = result.current;
    const token = before.begin();
    act(() => rerender());
    expect(result.current).toBe(before);
    // And the round survived the render, which a `useState` counter would not
    // have done without a commit.
    expect(result.current.isCurrent(token)).toBe(true);
  });

  test("two hooks keep separate rounds", () => {
    const a = renderHook(() => useLatestOnly());
    const b = renderHook(() => useLatestOnly());
    const aToken = a.result.current.begin();
    b.result.current.begin();
    b.result.current.begin();
    // B advancing twice says nothing about A.
    expect(a.result.current.isCurrent(aToken)).toBe(true);
  });
});
