import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { frameSize } from "../poster-frame";
import { PosterStack } from "../poster-stack";

// Matches `OFFSET_X` / `OFFSET_Y` in poster-stack.tsx (three frames → two gaps).
const OFFSET_X = 8;
const OFFSET_Y = 6;
const GAPS = 2;

describe("PosterStack", () => {
  test("draws the three layout variants overlapping, offset by a few px each", () => {
    const { container } = render(<PosterStack ratio="1:1" size={84} />);
    const stack = container.firstElementChild as HTMLElement;
    expect(stack.getAttribute("aria-hidden")).toBe("true");
    const svgs = Array.from(stack.querySelectorAll("svg"));
    expect(svgs).toHaveLength(3);
    // Each frame is offset a few px further than the last — the static stand-in
    // for the mockup's cross-fade: all three layouts visible at once.
    const lefts = svgs.map((svg) => (svg.parentElement as HTMLElement).style.left);
    const tops = svgs.map((svg) => (svg.parentElement as HTMLElement).style.top);
    expect(lefts).toEqual(["0px", "8px", "16px"]);
    expect(tops).toEqual(["0px", "6px", "12px"]);
    // The three variants are actually distinct: pA, pB and pC each appear once.
    expect(svgs.filter((svg) => svg.querySelector('rect[class*="fill-brand-primary/80"]'))).toHaveLength(1);
    expect(svgs.filter((svg) => svg.querySelector("circle"))).toHaveLength(1);
  });

  test("defaults to the square ratio and the 84px frame", () => {
    const { container } = render(<PosterStack />);
    const svgs = Array.from(container.querySelectorAll("svg")) as SVGSVGElement[];
    expect(svgs).toHaveLength(3);
    for (const svg of svgs) {
      expect(svg.getAttribute("width")).toBe("84");
      expect(svg.getAttribute("height")).toBe("84");
    }
  });

  test("the wrapper is the frame's real box plus the offsets, not size on both axes", () => {
    // At 9:16, `size` is the *long* side: each frame is 0.5625·size wide. A
    // wrapper of `size + 2·OFFSET` on both axes is ~44 % empty width, and
    // PreviewPanel then centres the empty box. Assert the style attribute
    // (not layout) so a revert to `size` on both axes fails here.
    const size = 84;
    const { width, height } = frameSize("9:16", size);
    const { container } = render(<PosterStack ratio="9:16" size={size} />);
    const stack = container.firstElementChild as HTMLElement;
    expect(stack.style.width).toBe(`${width + GAPS * OFFSET_X}px`);
    expect(stack.style.height).toBe(`${height + GAPS * OFFSET_Y}px`);
  });

  test("a display spec sizes the stack from resolveCanvas", () => {
    const size = 84;
    const { width, height } = frameSize({ size: "728x90" }, size);
    const { container } = render(<PosterStack spec={{ size: "728x90" }} size={size} />);
    const stack = container.firstElementChild as HTMLElement;
    expect(parseFloat(stack.style.width)).toBeCloseTo(width + GAPS * OFFSET_X);
    expect(parseFloat(stack.style.height)).toBeCloseTo(height + GAPS * OFFSET_Y);
    expect(width / height).toBeCloseTo(728 / 90);
  });
});
