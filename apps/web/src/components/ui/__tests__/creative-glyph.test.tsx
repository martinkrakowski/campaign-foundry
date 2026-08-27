import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { CreativeGlyph } from "../creative-glyph";

/** rects in draw order: ground, shade, accent band, long bar, short bar. */
const rects = (container: HTMLElement) => Array.from(container.querySelectorAll("rect"));

describe("CreativeGlyph", () => {
  test("is a decorative svg drawing the compositor's layer order at the default size", () => {
    const { container } = render(<CreativeGlyph />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.getAttribute("width")).toBe("46");
    expect(svg.getAttribute("height")).toBe("46");

    const [ground, shade, band, longBar, shortBar] = rects(container);
    expect(ground.getAttribute("class")).toContain("fill-text-muted");
    expect(shade.getAttribute("fill")).toMatch(/^url\(#creative-glyph-shade-/);
    expect(band.getAttribute("class")).toContain("fill-brand-primary");
    expect(longBar.getAttribute("class")).toContain("fill-text-primary");
    expect(shortBar.getAttribute("class")).toContain("fill-text-primary");
  });

  test("defaults to a top headline drawn bold: band flush to the top edge, shade 0.7, thick bars", () => {
    const { container } = render(<CreativeGlyph />);
    const [, , band, longBar, shortBar] = rects(container);
    // solid accent band = height * 0.05, flush to the headline edge
    expect(Number(band.getAttribute("y"))).toBe(0);
    expect(Number(band.getAttribute("height"))).toBeCloseTo(2.3, 5);
    // shadeAlpha mirrors NodeCanvasCompositor.prepare: subtle ? 0.4 : 0.7
    const stops = Array.from(container.querySelectorAll("stop"));
    expect(Number(stops[1].getAttribute("stop-opacity"))).toBe(0.7);
    // bold text weight → thicker bars, near the top edge
    expect(Number(longBar.getAttribute("height"))).toBe(4);
    expect(Number(shortBar.getAttribute("height"))).toBe(4);
    expect(Number(longBar.getAttribute("y"))).toBe(8);
    expect(Number(shortBar.getAttribute("y"))).toBe(15);
  });

  test("headline-bottom mirrors: band, shade gradient and bars flip to the bottom edge", () => {
    const { container } = render(<CreativeGlyph layout="headline-bottom" />);
    const [, , band, longBar, shortBar] = rects(container);
    expect(Number(band.getAttribute("y"))).toBeCloseTo(46 - 2.3, 5);
    const gradient = container.querySelector("linearGradient") as SVGLinearGradientElement;
    // the compositor's shade starts at 0.45h and darkens toward the bottom edge
    expect(gradient.getAttribute("y1")).toBe("0.45");
    expect(gradient.getAttribute("y2")).toBe("1");
    expect(Number(longBar.getAttribute("y"))).toBe(34);
    expect(Number(shortBar.getAttribute("y"))).toBe(27);
  });

  test("subtle tone halves the shade and thins the bars", () => {
    const { container } = render(<CreativeGlyph tone="subtle" />);
    const stops = Array.from(container.querySelectorAll("stop"));
    expect(Number(stops[1].getAttribute("stop-opacity"))).toBe(0.4);
    const [, , , longBar, shortBar] = rects(container);
    expect(Number(longBar.getAttribute("height"))).toBe(2.5);
    expect(Number(shortBar.getAttribute("height"))).toBe(2.5);
  });

  test("an explicit size scales the drawing without changing the arrangement", () => {
    const { container } = render(<CreativeGlyph size={60} />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("width")).toBe("60");
    expect(svg.getAttribute("height")).toBe("60");
    expect(svg.getAttribute("viewBox")).toBe("0 0 46 46");
  });

  test("each instance owns its gradient, so side-by-side glyphs cannot cross-paint", () => {
    const { container } = render(
      <>
        <CreativeGlyph layout="headline-top" />
        <CreativeGlyph layout="headline-bottom" />
      </>,
    );
    const gradients = Array.from(container.querySelectorAll("linearGradient"));
    expect(gradients).toHaveLength(2);
    expect(gradients[0].id).not.toBe(gradients[1].id);
    expect(gradients[0].getAttribute("y1")).toBe("0.55");
    expect(gradients[1].getAttribute("y1")).toBe("0.45");
    // each shade rect references its own gradient
    const shades = rects(container).filter((rect) => (rect.getAttribute("fill") ?? "").startsWith("url(#"));
    expect(shades[0].getAttribute("fill")).toBe(`url(#${gradients[0].id})`);
    expect(shades[1].getAttribute("fill")).toBe(`url(#${gradients[1].id})`);
  });

  test("the contrast shade is black in every theme — the compositor's is", () => {
    // Regression: deriving the gradient from --color-background inverted it in the light
    // theme (#ffffff), lightening the headline edge while the compositor always overlays
    // rgba(0, 0, 0, shadeAlpha). The card would then misrepresent the creative it previews.
    const { container } = render(<CreativeGlyph layout="headline-top" tone="bold" />);
    const stops = [...container.querySelectorAll("stop")];
    expect(stops).toHaveLength(2);
    for (const stop of stops) {
      expect(stop.getAttribute("stop-color")).toBe("#000000");
    }
    expect(stops[1].getAttribute("stop-opacity")).toBe("0.7");
  });

  test("subtle carries the compositor's lighter shade", () => {
    const { container } = render(<CreativeGlyph layout="headline-top" tone="subtle" />);
    const stops = [...container.querySelectorAll("stop")];
    expect(stops[1].getAttribute("stop-opacity")).toBe("0.4");
  });
});
