import { describe, test, expect, afterEach, vi } from "vitest";
import { useRef } from "react";
import { render, act } from "@testing-library/react";
import { useInlineWidth } from "../use-min-inline-size";

/**
 * happy-dom's `ResizeObserver` never invokes its callback (no real layout
 * engine produces a content/border box) — confirmed directly against
 * `happy-dom`'s `Window` before writing this suite. So every assertion here
 * drives a stubbed observer's callback by hand.
 *
 * **What left this file with RS2, and what stops being true.** It also covered
 * `useMinInlineSize` and `initialMinInlineSizeSeed` — the JS mirror of the
 * preview rail's `[@container(min-width:56rem)]` visibility query, observing the
 * editor row that query read. Both are deleted, so their assertions are deleted
 * with them rather than re-pointed at a hook that no longer exists: there is no
 * container query left to mirror (the rail wears the shell's viewport `lg:` gate
 * now) and no editor row left to observe (the rail is a sibling of `<main>`).
 *
 * Two of those assertions were about the hook and NOT about the container, so
 * they are carried, not dropped: the server-prerender guard (a `"use client"`
 * component is prerendered at build time, where `window` does not exist — this
 * broke `yarn build` once) and "the gate hides without unmounting, so the WORK
 * must stop, not only the result". Both are in
 * `use-viewport-min-width.test.tsx`, against the hook that now answers the
 * question. The observer-specific ones (a real measurement, a zero measurement,
 * disconnect on unmount, no global `ResizeObserver`) still hold for
 * `useInlineWidth` below, which is the same mechanism and is unchanged.
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

const originalInnerWidth = window.innerWidth;

afterEach(() => {
  FakeResizeObserver.instances = [];
  vi.unstubAllGlobals();
  Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
});

describe("useInlineWidth — the measured width (TS1's fit)", () => {
  /** Reports the hook's answer, with a ref a test can leave unattached. */
  const WidthProbe = ({ attach = true }: { attach?: boolean }) => {
    const ref = useRef<HTMLDivElement>(null);
    const width = useInlineWidth(ref);
    return (
      <div ref={attach ? ref : undefined} data-testid="width">
        {width}
      </div>
    );
  };

  test("answers 0 until something measures it — never a guessed width", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { getByTestId } = render(<WidthProbe />);
    // There is no `window.innerWidth` seed here on purpose: a WIDTH taken from
    // the viewport would be wrong by the shell's sidebar and would show as a
    // visible re-fit on the first real measurement.
    expect(getByTestId("width").textContent).toBe("0");
  });

  test("a real measurement is reported, and a zero one is ignored", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { getByTestId } = render(<WidthProbe />);
    const observer = FakeResizeObserver.instances[0];

    observer.fire(640);
    expect(getByTestId("width").textContent).toBe("640");

    // Zero is "not laid out yet" — a collapse to nothing would be a layout the
    // caller should re-fit for, and this element cannot have one.
    observer.fire(0);
    expect(getByTestId("width").textContent).toBe("640");
  });

  test("an unattached ref observes nothing rather than throwing", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { getByTestId } = render(<WidthProbe attach={false} />);
    expect(FakeResizeObserver.instances.length).toBe(0);
    expect(getByTestId("width").textContent).toBe("0");
  });

  test("an environment with no ResizeObserver at all is answered, not crashed", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { getByTestId } = render(<WidthProbe />);
    expect(getByTestId("width").textContent).toBe("0");
  });

  test("the observer is disconnected on unmount", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const view = render(<WidthProbe />);
    const observer = FakeResizeObserver.instances[0];
    expect(observer.disconnected).toBe(false);
    view.unmount();
    expect(observer.disconnected).toBe(true);
  });
});
