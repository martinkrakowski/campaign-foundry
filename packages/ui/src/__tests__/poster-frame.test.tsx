import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { PosterFrame, frameSize } from "../poster-frame";

describe("PosterFrame", () => {
  test("frameSize treats size as the long side", () => {
    expect(frameSize("1:1", 96)).toEqual({ width: 96, height: 96 });
    expect(frameSize("9:16", 96)).toEqual({ width: 54, height: 96 });
    expect(frameSize("16:9", 96)).toEqual({ width: 96, height: 54 });
    expect(frameSize({ size: "728x90" }, 728)).toEqual({ width: 728, height: 90 });
  });

  test("a 728x90 poster is a very wide, very short rectangle (F4)", () => {
    const { container } = render(<PosterFrame spec={{ size: "728x90" }} variant="pA" />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    const width = Number(svg.getAttribute("width"));
    const height = Number(svg.getAttribute("height"));
    expect(width / height).toBeCloseTo(728 / 90);
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${width} ${height}`);
  });

  test("draws each ratio at its true proportion from the long side", () => {
    const dimensions = [
      ["1:1", 96, 96],
      ["9:16", 54, 96],
      ["16:9", 96, 54],
    ] as const;
    for (const [ratio, width, height] of dimensions) {
      const { container, unmount } = render(<PosterFrame ratio={ratio} variant="pA" />);
      const svg = container.querySelector("svg") as SVGSVGElement;
      expect(svg.getAttribute("width")).toBe(String(width));
      expect(svg.getAttribute("height")).toBe(String(height));
      expect(svg.getAttribute("viewBox")).toBe(`0 0 ${width} ${height}`);
      unmount();
    }
  });

  test("scales the frame by its long side", () => {
    const { container } = render(<PosterFrame ratio="9:16" variant="pA" size={48} />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("width")).toBe("27");
    expect(svg.getAttribute("height")).toBe("48");
  });

  test("pA lays the image across the top, text beneath, CTA bottom-left", () => {
    // 1:1 at 96 → viewBox 0 0 96 96; pA's image is 82 % wide, 52 % tall, at the top.
    const { container } = render(<PosterFrame ratio="1:1" variant="pA" size={96} />);
    const rects = Array.from(container.querySelectorAll("rect"));
    const image = rects.find((rect) => rect.getAttribute("class")?.includes("fill-text-muted/[0.18]"));
    expect(image).toBeTruthy();
    expect(Number(image?.getAttribute("x"))).toBeCloseTo(0.09 * 96);
    expect(Number(image?.getAttribute("y"))).toBeCloseTo(0.07 * 96);
    expect(Number(image?.getAttribute("width"))).toBeCloseTo(0.82 * 96);
    expect(Number(image?.getAttribute("height"))).toBeCloseTo(0.52 * 96);
    expect(container.querySelector('rect[class*="fill-text-secondary/50"]')).toBeTruthy();
    expect(container.querySelector('rect[class*="fill-text-secondary/30"]')).toBeTruthy();
    const cta = container.querySelector('rect[class*="fill-brand-primary"]');
    expect(cta).toBeTruthy();
    // CTA bottom-left: left edge inside the frame, bottom quarter.
    expect(Number(cta?.getAttribute("x"))).toBeCloseTo(0.09 * 96);
    expect(Number(cta?.getAttribute("y"))).toBeGreaterThan(0.8 * 96);
  });

  test("pB lays the tinted image down the left with text to its right", () => {
    const { container } = render(<PosterFrame ratio="1:1" variant="pB" size={96} />);
    const image = container.querySelector('rect[class*="fill-brand-primary/80"]');
    expect(image).toBeTruthy();
    // Image left: 38 % wide, 84 % tall — taller than wide, hugging the left edge.
    expect(Number(image?.getAttribute("width"))).toBeCloseTo(0.38 * 96);
    expect(Number(image?.getAttribute("height"))).toBeCloseTo(0.84 * 96);
    expect(Number(image?.getAttribute("x"))).toBeLessThan(0.1 * 96);
    // Text right: the headline bar starts right of the image.
    const headline = container.querySelector('rect[class*="fill-text-secondary/50"]');
    expect(Number(headline?.getAttribute("x"))).toBeGreaterThan(0.4 * 96);
    // Round avatar bottom-right.
    const avatar = container.querySelector("circle");
    expect(avatar).toBeTruthy();
    expect(Number(avatar?.getAttribute("cx"))).toBeGreaterThan(0.8 * 96);
  });

  test("pC centres the round image, the text and the CTA", () => {
    const { container } = render(<PosterFrame ratio="1:1" variant="pC" size={96} />);
    const rects = Array.from(container.querySelectorAll("rect"));
    const image = rects.find((rect) => rect.getAttribute("class")?.includes("fill-text-muted/[0.18]"));
    expect(image).toBeTruthy();
    // Round: the rx rounds the rect into a circle at half its width.
    expect(image?.getAttribute("rx")).toBe(String(Number(image?.getAttribute("width")) / 2));
    const centre = (element: SVGRectElement) =>
      Number(element.getAttribute("x")) + Number(element.getAttribute("width")) / 2;
    expect(centre(image as SVGRectElement)).toBeCloseTo(48);
    for (const fill of ["fill-text-secondary/50", "fill-text-secondary/30", "fill-brand-primary"]) {
      const bar = container.querySelector(`rect[class*="${fill}"]`) as SVGRectElement;
      expect(centre(bar)).toBeCloseTo(48);
    }
  });

  test("blank × each variant draws a dashed empty frame and none of the content layers", () => {
    for (const variant of ["pA", "pB", "pC"] as const) {
      const { container, unmount } = render(<PosterFrame ratio="1:1" variant={variant} blank />);
      const svg = container.querySelector("svg") as SVGSVGElement;
      const frame = svg.querySelector("rect") as SVGRectElement;
      expect(frame.getAttribute("stroke-dasharray")).toBe("4 3");
      for (const fill of [
        "fill-text-muted/[0.18]",
        "fill-text-secondary/50",
        "fill-text-secondary/30",
        "fill-brand-primary",
      ]) {
        expect(
          Array.from(svg.querySelectorAll("[class]")).some((node) => node.getAttribute("class")?.includes(fill)),
        ).toBe(false);
      }
      // pB's avatar is gated on `!blank`; dropping that conjunct stays green if
      // blank is only ever mounted as pA. Each variant must assert no circle.
      expect(svg.querySelector("circle")).toBeNull();
      unmount();
    }
  });

  test("is decorative: aria-hidden, not focusable", () => {
    const { container } = render(<PosterFrame ratio="16:9" variant="pC" />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
  });
});
