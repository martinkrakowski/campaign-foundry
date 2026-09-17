import { describe, test, expect, afterEach, vi } from "vitest";
import { useRef } from "react";
import { render, act } from "@testing-library/react";
import { useMinInlineSize, initialMinInlineSizeSeed, PREVIEW_RAIL_MIN_INLINE_PX } from "../use-min-inline-size";

/**
 * happy-dom's `ResizeObserver` never invokes its callback (no real layout
 * engine produces a content/border box) — confirmed directly against
 * `happy-dom`'s `Window` before writing this suite. So every assertion here
 * either exercises the `window.innerWidth` seed (the path happy-dom CAN
 * drive) or drives a stubbed observer's callback by hand.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: Element[] = [];
  disconnected = false;
  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true;
  }
  /** Fire the observer as a real one would, at the given content-box width. */
  fire(width: number): void {
    act(() => {
      this.callback(
        [{ contentRect: { width } as DOMRectReadOnly } as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    });
  }
}

const Probe = ({ minPx }: { minPx: number }) => {
  const ref = useRef<HTMLDivElement>(null);
  const atLeast = useMinInlineSize(ref, minPx);
  return (
    <div ref={ref} data-testid="probe">
      {atLeast ? "wide" : "narrow"}
    </div>
  );
};

const originalInnerWidth = window.innerWidth;

afterEach(() => {
  FakeResizeObserver.instances = [];
  vi.unstubAllGlobals();
  Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
});

describe("initialMinInlineSizeSeed — the server path", () => {
  /**
   * The regression this pins: a `"use client"` component is still
   * PRERENDERED ON THE SERVER at Next build time, and a `useState`
   * initializer runs during that server render — where `window` does not
   * exist. A first version of this hook read `window.innerWidth` directly
   * from the initializer with no guard, reasoning (wrongly) that "only
   * client chrome calls this" was enough; it broke `yarn build`
   * (`ReferenceError: window is not defined` prerendering `/brief/new`).
   * `vi.stubGlobal` removes `window` for exactly this one assertion, rather
   * than deleting it out from under the whole DOM test environment.
   */
  test("with no window at all, seeds false rather than throwing", () => {
    vi.stubGlobal("window", undefined);
    expect(initialMinInlineSizeSeed(PREVIEW_RAIL_MIN_INLINE_PX)).toBe(false);
  });

  test("with a window, reads window.innerWidth exactly as the hook does", () => {
    Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
    expect(initialMinInlineSizeSeed(PREVIEW_RAIL_MIN_INLINE_PX)).toBe(false);

    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    expect(initialMinInlineSizeSeed(PREVIEW_RAIL_MIN_INLINE_PX)).toBe(true);
  });
});

describe("useMinInlineSize", () => {
  test("seeds from window.innerWidth before any observation arrives", () => {
    Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
    const { getByTestId } = render(<Probe minPx={PREVIEW_RAIL_MIN_INLINE_PX} />);
    expect(getByTestId("probe").textContent).toBe("narrow");
  });

  test("a viewport at or above the breakpoint seeds true", () => {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    const { getByTestId } = render(<Probe minPx={PREVIEW_RAIL_MIN_INLINE_PX} />);
    expect(getByTestId("probe").textContent).toBe("wide");
  });

  test("observes the ref'd element and updates on a real measurement", () => {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { getByTestId } = render(<Probe minPx={PREVIEW_RAIL_MIN_INLINE_PX} />);
    expect(getByTestId("probe").textContent).toBe("wide"); // seeded

    const observer = FakeResizeObserver.instances[0];
    expect(observer.observed).toEqual([getByTestId("probe")]);

    observer.fire(700); // narrower than the container's real inline size
    expect(getByTestId("probe").textContent).toBe("narrow");

    observer.fire(920);
    expect(getByTestId("probe").textContent).toBe("wide");
  });

  test("a zero measurement is 'not laid out yet', not a real collapse — the previous verdict stands", () => {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { getByTestId } = render(<Probe minPx={PREVIEW_RAIL_MIN_INLINE_PX} />);
    const observer = FakeResizeObserver.instances[0];

    observer.fire(700);
    expect(getByTestId("probe").textContent).toBe("narrow");

    observer.fire(0);
    expect(getByTestId("probe").textContent).toBe("narrow"); // unchanged, not forced "wide"
  });

  test("disconnects the observer on unmount", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { unmount } = render(<Probe minPx={PREVIEW_RAIL_MIN_INLINE_PX} />);
    const observer = FakeResizeObserver.instances[0];
    unmount();
    expect(observer.disconnected).toBe(true);
  });

  test("without a global ResizeObserver, the seed stands and nothing throws", () => {
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true });
    vi.stubGlobal("ResizeObserver", undefined);
    const { getByTestId } = render(<Probe minPx={PREVIEW_RAIL_MIN_INLINE_PX} />);
    expect(getByTestId("probe").textContent).toBe("wide");
  });
});
