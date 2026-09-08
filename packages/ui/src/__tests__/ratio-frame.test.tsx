import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { RatioFrame } from "../ratio-frame";

describe("RatioFrame", () => {
  test("draws each canvas at its true proportion from one ratio prop", () => {
    const dimensions = [
      ["1:1", 48, 48],
      ["9:16", 27, 48],
      ["16:9", 48, 27],
    ] as const;
    for (const [ratio, width, height] of dimensions) {
      const { container, unmount } = render(<RatioFrame ratio={ratio} />);
      const svg = container.querySelector("svg") as SVGSVGElement;
      expect(svg.getAttribute("width")).toBe(String(width));
      expect(svg.getAttribute("height")).toBe(String(height));
      expect(svg.getAttribute("viewBox")).toBe(`0 0 ${width} ${height}`);
      unmount();
    }
  });

  test("scales the frame by its long side", () => {
    const { container } = render(<RatioFrame ratio="9:16" size={32} />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("width")).toBe("18");
    expect(svg.getAttribute("height")).toBe("32");
  });

  test("is decorative: aria-hidden, no accessible name, theme tokens only", () => {
    const { container } = render(<RatioFrame ratio="16:9" />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    const rect = svg.querySelector("rect") as SVGRectElement;
    expect(rect.getAttribute("class")).toContain("fill-surface-2");
    expect(rect.getAttribute("class")).toContain("stroke-border");
    expect(rect.getAttribute("stroke-width")).toBe("1.5");
  });
});
