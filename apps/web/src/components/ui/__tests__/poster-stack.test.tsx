import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { PosterStack } from "../poster-stack";

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
});
