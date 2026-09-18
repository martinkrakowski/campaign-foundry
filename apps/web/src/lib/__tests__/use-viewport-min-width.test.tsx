import { describe, test, expect, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import {
  useViewportMinWidth,
  viewportAtLeast,
  RAIL_VIEWPORT_MIN_PX,
} from "../use-viewport-min-width";

/**
 * RS2's replacement for `useMinInlineSize`, and the two properties carried over
 * from that hook's suite because they were about the HOOK and not about the
 * container query it mirrored:
 *
 * 1. the server-prerender guard — a `"use client"` component is still prerendered
 *    at Next build time, where `window` does not exist;
 * 2. the gate hides without unmounting, so a caller has to be able to stop the
 *    WORK (the `/preview-frame` fetch) rather than only hide the result.
 *
 * The rest of that suite was about `ResizeObserver` and the editor row, neither of
 * which this hook has.
 */
const Probe = ({ minPx }: { minPx: number }) => {
  const atLeast = useViewportMinWidth(minPx);
  return <div data-testid="probe">{atLeast ? "wide" : "narrow"}</div>;
};

const setViewport = (width: number) => {
  (
    window as unknown as { happyDOM: { setViewport: (v: { width: number }) => void } }
  ).happyDOM.setViewport({ width });
};

const originalWidth = window.innerWidth;

afterEach(() => {
  vi.unstubAllGlobals();
  setViewport(originalWidth);
});

describe("viewportAtLeast — the seed, including the server path", () => {
  /**
   * The regression this pins is a real one, from this hook's predecessor: reading
   * `window.innerWidth` from a `useState` initializer with no guard broke
   * `yarn build` (`ReferenceError: window is not defined` prerendering
   * `/brief/new`). `vi.stubGlobal` removes `window` for exactly this assertion
   * rather than deleting it under the whole DOM environment.
   */
  test("with no window at all, seeds false rather than throwing", () => {
    vi.stubGlobal("window", undefined);
    expect(viewportAtLeast(RAIL_VIEWPORT_MIN_PX)).toBe(false);
  });

  test("false is the safe direction: no brief reaches the dock, so nothing fetches", () => {
    // Not an arbitrary choice of default. `true` on the server would hand the dock
    // a brief during prerender and on the first client paint, which is a request
    // for a frame nobody has asked to see yet.
    vi.stubGlobal("window", undefined);
    expect(viewportAtLeast(1)).toBe(false);
  });

  test("with a window, reads the viewport at the breakpoint's own boundary", () => {
    setViewport(RAIL_VIEWPORT_MIN_PX - 1);
    expect(viewportAtLeast(RAIL_VIEWPORT_MIN_PX)).toBe(false);

    setViewport(RAIL_VIEWPORT_MIN_PX);
    expect(viewportAtLeast(RAIL_VIEWPORT_MIN_PX)).toBe(true);
  });
});

describe("useViewportMinWidth", () => {
  test("seeds from the viewport before any event arrives", () => {
    setViewport(500);
    const { getByTestId } = render(<Probe minPx={RAIL_VIEWPORT_MIN_PX} />);
    expect(getByTestId("probe").textContent).toBe("narrow");
  });

  test("a viewport at the breakpoint — not one px past it — reads wide", () => {
    setViewport(RAIL_VIEWPORT_MIN_PX);
    const { getByTestId } = render(<Probe minPx={RAIL_VIEWPORT_MIN_PX} />);
    expect(getByTestId("probe").textContent).toBe("wide");
  });

  test("a resize across the breakpoint is answered, in both directions", () => {
    setViewport(1280);
    const { getByTestId } = render(<Probe minPx={RAIL_VIEWPORT_MIN_PX} />);
    expect(getByTestId("probe").textContent).toBe("wide");

    act(() => {
      setViewport(RAIL_VIEWPORT_MIN_PX - 1);
      window.dispatchEvent(new Event("resize"));
    });
    expect(getByTestId("probe").textContent).toBe("narrow");

    act(() => {
      setViewport(RAIL_VIEWPORT_MIN_PX);
      window.dispatchEvent(new Event("resize"));
    });
    expect(getByTestId("probe").textContent).toBe("wide");
  });

  test("a hydration mismatch corrects itself: a false seed is re-read on mount", () => {
    // The server seeds `false` with no viewport to read. The effect's first read is
    // what corrects it, so this is that read — driven by rendering with a wide
    // viewport while the state starts from a narrow one.
    const seeds: boolean[] = [];
    const Spy = () => {
      const atLeast = useViewportMinWidth(RAIL_VIEWPORT_MIN_PX);
      seeds.push(atLeast);
      return null;
    };
    setViewport(1280);
    render(<Spy />);
    expect(seeds[seeds.length - 1]).toBe(true);
    // A same-value write does not cost a render: the seed was already right here,
    // so the effect's read must not have queued one.
    expect(seeds).toEqual([true]);
  });

  test("the listener is removed on unmount", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const view = render(<Probe minPx={RAIL_VIEWPORT_MIN_PX} />);
    view.unmount();
    expect(remove.mock.calls.some(([type]) => type === "resize")).toBe(true);
  });

  test("a changed breakpoint re-subscribes rather than answering the old number", () => {
    setViewport(1100);
    const { getByTestId, rerender } = render(<Probe minPx={RAIL_VIEWPORT_MIN_PX} />);
    expect(getByTestId("probe").textContent).toBe("wide");
    rerender(<Probe minPx={1280} />);
    expect(getByTestId("probe").textContent).toBe("narrow");
  });
});
