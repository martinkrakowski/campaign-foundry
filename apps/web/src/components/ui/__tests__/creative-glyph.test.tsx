import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { CreativeGlyph } from "../creative-glyph";

/** rects in draw order: ground, shade, soft fade, accent band, long bar, short bar. */
const rects = (container: HTMLElement) => Array.from(container.querySelectorAll("rect"));

describe("CreativeGlyph", () => {
  test("is a decorative svg drawing the compositor's layer order at the default size", () => {
    const { container } = render(<CreativeGlyph />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.getAttribute("width")).toBe("46");
    expect(svg.getAttribute("height")).toBe("46");

    const [ground, shade, , band, longBar, shortBar] = rects(container);
    expect(ground.getAttribute("class")).toContain("fill-text-muted");
    expect(shade.getAttribute("fill")).toMatch(/^url\(#creative-glyph-shade-/);
    expect(band.getAttribute("class")).toContain("fill-brand-primary");
    expect(longBar.getAttribute("class")).toContain("fill-text-primary");
    expect(shortBar.getAttribute("class")).toContain("fill-text-primary");
  });

  test("defaults to a top headline drawn bold: band flush to the top edge, shade 0.7, thick bars", () => {
    const { container } = render(<CreativeGlyph />);
    const [, , , band, longBar, shortBar] = rects(container);
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
    const [, , , band, longBar, shortBar] = rects(container);
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
    const [, , , , longBar, shortBar] = rects(container);
    expect(Number(longBar.getAttribute("height"))).toBe(2.5);
    expect(Number(shortBar.getAttribute("height"))).toBe(2.5);
  });

  test.each(["ken-burns-in", "ken-burns-out", "headline-rise", "accent-wipe"] as const)(
    "motion %s sets data-motion and renders cue indicator",
    (motion) => {
      const { container } = render(<CreativeGlyph motion={motion} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("data-motion")).toBe(motion);
      const cue = container.querySelector(".glyph-cue");
      expect(cue).toBeTruthy();
      expect(cue!.children.length).toBeGreaterThan(0);
    },
  );

  test("accent-wipe on headline-bottom flips fade layer and cue arrow", () => {
    const { container } = render(<CreativeGlyph motion="accent-wipe" layout="headline-bottom" />);
    const [, , fade] = rects(container);
    expect(Number(fade.getAttribute("y"))).toBe(46 - 2.3 - 14);
    const cue = container.querySelector(".glyph-cue")!;
    expect(cue).toBeTruthy();
  });

  test("an explicit size scales the drawing without changing the arrangement", () => {
    const { container } = render(<CreativeGlyph size={60} />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("width")).toBe("60");
    expect(svg.getAttribute("height")).toBe("60");
    expect(svg.getAttribute("viewBox")).toBe("0 0 46 46");
  });

  test("each instance owns its gradients, so side-by-side glyphs cannot cross-paint", () => {
    const { container } = render(
      <>
        <CreativeGlyph layout="headline-top" />
        <CreativeGlyph layout="headline-bottom" />
      </>,
    );
    // every glyph now draws two gradients (contrast shade + the fade layer), so two
    // side-by-side glyphs yield four, all with instance-scoped ids
    const gradients = Array.from(container.querySelectorAll("linearGradient"));
    expect(gradients).toHaveLength(4);
    expect(new Set(gradients.map((g) => g.id)).size).toBe(4);
    // instance 1 (top): shade (y1 0.55) then fade (y1 0); instance 2 (bottom) mirrors
    expect(gradients[0].getAttribute("y1")).toBe("0.55");
    expect(gradients[1].getAttribute("y1")).toBe("0");
    expect(gradients[2].getAttribute("y1")).toBe("0.45");
    expect(gradients[3].getAttribute("y1")).toBe("1");
    // each contrast-shade rect references its own contrast-shade gradient
    const shades = rects(container).filter((rect) => (rect.getAttribute("fill") ?? "").startsWith("url(#creative-glyph-shade-"));
    expect(shades[0].getAttribute("fill")).toBe(`url(#${gradients[0].id})`);
    expect(shades[1].getAttribute("fill")).toBe(`url(#${gradients[2].id})`);
  });

  test("the contrast shade is black in every theme — the compositor's is", () => {
    // Regression: deriving the gradient from --color-background inverted it in the light
    // theme (#ffffff), lightening the headline edge while the compositor always overlays
    // rgba(0, 0, 0, shadeAlpha). The card would then misrepresent the creative it previews.
    // Filter to the shade stops: the motion fade layer legitimately uses the brand colour.
    const { container } = render(<CreativeGlyph layout="headline-top" tone="bold" />);
    const blackStops = [...container.querySelectorAll("stop")].filter(
      (stop) => stop.getAttribute("stop-color") === "#000000",
    );
    expect(blackStops).toHaveLength(2);
    for (const stop of blackStops) {
      expect(stop.getAttribute("stop-color")).toBe("#000000");
    }
    expect(blackStops[1].getAttribute("stop-opacity")).toBe("0.7");
  });

  test("subtle carries the compositor's lighter shade", () => {
    const { container } = render(<CreativeGlyph layout="headline-top" tone="subtle" />);
    const stops = [...container.querySelectorAll("stop")];
    expect(stops[1].getAttribute("stop-opacity")).toBe("0.4");
  });
});
