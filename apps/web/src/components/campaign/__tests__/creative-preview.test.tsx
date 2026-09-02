import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import type { AspectRatioValue } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { RATIO_DIMENSIONS } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { CREATIVE_GEOMETRY } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import {
  CreativePreview,
  PREVIEW_MAX_LINES,
  PREVIEW_FONT_RATIO,
  PREVIEW_FONT_FLOOR_FRACTION,
  PREVIEW_ANCHOR_TOP,
  PREVIEW_ANCHOR_MIDDLE,
  PREVIEW_ANCHOR_BOTTOM,
  CHAR_WIDTH_RATIO,
  fitHeadline,
  wrapHeadline,
  resolveOverlappingLogoY,
} from "../CreativePreview";
import { LAYERS, times } from "@/components/ui/preview-layers";

const svgOf = (ui: React.ReactNode): SVGSVGElement =>
  render(<div>{ui}</div>).container.querySelector("svg")!;

const bandRect = (svg: SVGSVGElement): SVGElement =>
  Array.from(svg.querySelectorAll("rect")).find((r) => r.getAttribute("class") === "fill-[var(--c)]")!;

const fadeRect = (svg: SVGSVGElement): SVGElement =>
  // Two rects paint gradients — the full-canvas shade, then the accent fade.
  Array.from(svg.querySelectorAll("rect"))
    .filter((r) => r.getAttribute("fill")?.startsWith("url("))
    .at(-1)!;

const logoRect = (svg: SVGSVGElement): SVGElement =>
  Array.from(svg.querySelectorAll("rect")).find((r) => r.getAttribute("fill") === "#ffffff")!;

/** The fitHeadline arguments the component itself derives, per ratio. */
const fitArgs = (ratio: AspectRatioValue) => {
  const { width: W, height: H } = RATIO_DIMENSIONS[ratio];
  const start = Math.round(W * PREVIEW_FONT_RATIO);
  return {
    W,
    H,
    textWidth: W - 2 * times(LAYERS.textEdge, W),
    maxHeight: H - 2 * times(LAYERS.headlineAnchor, H),
    start,
    min: Math.round(start * PREVIEW_FONT_FLOOR_FRACTION),
  };
};

describe("wrapHeadline", () => {
  test("breaks between words at the char budget, keeping words intact", () => {
    expect(wrapHeadline("Stay wild and hydrated", 9)).toEqual(["Stay wild", "and", "hydrated"]);
  });

  test("a word longer than the budget sits on its own line when breakWords is false", () => {
    expect(wrapHeadline("supercalifragilistic spirit", 7)).toEqual(["supercalifragilistic", "spirit"]);
  });

  test("a word longer than the budget is split across lines when breakWords is true", () => {
    expect(wrapHeadline("supercalifragilistic spirit", 7, true)).toEqual([
      "superca",
      "lifragi",
      "listic",
      "spirit",
    ]);
  });

  test("collapses whitespace drift and returns nothing for blank text", () => {
    expect(wrapHeadline("   ", 5)).toEqual([]);
    expect(wrapHeadline(" a   b ", 5)).toEqual(["a b"]);
  });
});

describe("fitHeadline", () => {
  test("short headline: one line at the starting size, no shrink", () => {
    const fit = fitHeadline("Stay wild", 1000, 800, 170);
    expect(fit.fontSize).toBe(170);
    expect(fit.lines).toEqual(["Stay wild"]);
  });

  test("long headline shrinks down to three lines", () => {
    const fit = fitHeadline("Stay wild and stay hydrated under the open sky", 700, 600, 200, 50);
    expect(fit.lines.length).toBeLessThanOrEqual(PREVIEW_MAX_LINES);
    expect(fit.fontSize).toBeLessThan(200);
    expect(fit.lines.flatMap((l) => l.split(" ")).join(" ")).toBe(
      "Stay wild and stay hydrated under the open sky",
    );
  });

  test("a single long word shrinks to fit width without breaking when possible", () => {
    const fit = fitHeadline("supercalifragilistic", 300, 200, 200, 20);
    expect(fit.lines).toEqual(["supercalifragilistic"]);
    expect(fit.fontSize).toBeLessThan(200);
    expect(fit.fontSize).toBeGreaterThanOrEqual(20);
  });

  test("a word that cannot fit at any size falls back to the exact floor and breaks", () => {
    const fit = fitHeadline("supercalifragilistic", 100, 100, 200, 50);
    expect(fit.fontSize).toBe(50);
    expect(fit.lines.every((line) => line.length <= Math.floor(100 / (CHAR_WIDTH_RATIO * 50)))).toBe(true);
  });

  test("blank headline fits with no lines", () => {
    const fit = fitHeadline("   ", 700, 800, 170);
    expect(fit.lines).toEqual([]);
    expect(fit.fontSize).toBe(170);
  });

  test("a block too shallow for even a floor-sized headline falls back to the exact floor", () => {
    // maxHeight below one floor-sized line can never satisfy — the loop falls back to minFontSize.
    const fit = fitHeadline("a b c d e", 500, 3, 100, 50);
    expect(fit.fontSize).toBe(50);
  });

  test("a deliberately long headline lands at the floor (the width-derived floor) and not beneath it", () => {
    // C1: the type scale is the compositor's — a fraction of canvas WIDTH,
    // floored at 0.4× of the start — not a fraction of the height. The copy is
    // long enough that even at the floor it cannot cram into three lines, so
    // the fitter falls back to the exact floor and breaks over-long words.
    const longHeadline =
      "This is a deliberately very long headline that exceeds three lines at every size the fitter can try and must therefore land exactly on the floor where the words are broken apart so the copy never overflows the text block";
    const { textWidth, maxHeight, start, min } = fitArgs("1:1");
    const fit = fitHeadline(longHeadline, textWidth, maxHeight, start, min);
    expect(fit.fontSize).toBe(min);
    expect(min).toBe(Math.round(start * CREATIVE_GEOMETRY.headlineTypeFloorFraction));
  });
});

describe("CreativePreview", () => {
  test("draws on the ratio's real canvas: 9:16 is genuinely tall", () => {
    const svg = svgOf(<CreativePreview primaryColor="#1473E6" ratio="9:16" />);
    expect(svg.getAttribute("viewBox")).toBe("0 0 1080 1920");
    expect(svg.getAttribute("width")).toBe("1080");
    expect(svg.getAttribute("height")).toBe("1920");
  });

  test("accent geometry follows the compositor fractions (top layout)", () => {
    const svg = svgOf(<CreativePreview primaryColor="#1473E6" layout="headline-top" />);
    const { height: H } = RATIO_DIMENSIONS["1:1"];
    const band = H * CREATIVE_GEOMETRY.accentSolidHeightFraction;
    // Top layout: the band sits flush to the top edge (the headline edge).
    expect(Number(bandRect(svg).getAttribute("y"))).toBe(0);
    expect(Number(bandRect(svg).getAttribute("height"))).toBe(band);
  });

  test("bottom layout flushes the band to the bottom edge", () => {
    const svg = svgOf(<CreativePreview primaryColor="#1473E6" layout="headline-bottom" />);
    const { height: H } = RATIO_DIMENSIONS["1:1"];
    expect(Number(bandRect(svg).getAttribute("y"))).toBe(H - H * CREATIVE_GEOMETRY.accentSolidHeightFraction);
  });

  test("the accent fade is the compositor's height, starting at full accent colour (C5)", () => {
    // The preview's fade was a 46-unit-miniature constant (~5× too tall) and
    // started at 0.6 opacity; the compositor's fade is height × 0.06, starting
    // continuous with the solid band. Assert the rendered rect and gradient.
    const svg = svgOf(<CreativePreview primaryColor="#1473E6" layout="headline-top" />);
    const { height: H } = RATIO_DIMENSIONS["1:1"];
    const fade = fadeRect(svg);
    const band = H * CREATIVE_GEOMETRY.accentSolidHeightFraction;
    expect(Number(fade.getAttribute("height"))).toBe(H * CREATIVE_GEOMETRY.accentFadeHeightFraction);
    expect(Number(fade.getAttribute("y"))).toBe(band);
    const stops = Array.from(svg.querySelectorAll("linearGradient")[1].querySelectorAll("stop"));
    expect(Number(stops[0]?.getAttribute("stop-opacity"))).toBe(1);
    expect(Number(stops[1]?.getAttribute("stop-opacity"))).toBe(0);
  });

  test("binds the product colour as --c and paints the band from it", () => {
    const svg = svgOf(<CreativePreview primaryColor="#F04E23" />);
    expect(svg.getAttribute("style")).toContain("--c");
    expect(bandRect(svg).getAttribute("class")).toBe("fill-[var(--c)]");
    const stops = Array.from(svg.querySelectorAll("linearGradient")[1].querySelectorAll("stop"));
    expect(stops.every((s) => s.getAttribute("stop-color") === "var(--c)")).toBe(true);
  });

  test("the contrast shade darkens per tone, mirroring the compositor alpha", () => {
    const bold = svgOf(<CreativePreview primaryColor="#1473E6" tone="bold" />);
    const subtle = svgOf(<CreativePreview primaryColor="#1473E6" tone="subtle" />);
    const shadeOf = (svg: SVGSVGElement) =>
      Array.from(svg.querySelectorAll("linearGradient")[0].querySelectorAll("stop")).at(-1);
    const shadeAlphaOf = (svg: SVGSVGElement) => Number(shadeOf(svg)!.getAttribute("stop-opacity"));
    expect(shadeAlphaOf(bold)).toBe(CREATIVE_GEOMETRY.shadeAlpha.bold);
    expect(shadeAlphaOf(subtle)).toBe(CREATIVE_GEOMETRY.shadeAlpha.subtle);
  });

  test("renders the headline as real wrapped svg text, never beyond three lines", () => {
    const svg = svgOf(<CreativePreview primaryColor="#1473E6" headline="Stay wild. Stay hydrated." />);
    const text = svg.querySelector("text")!;
    expect(text).not.toBeNull();
    const tspans = Array.from(text.querySelectorAll("tspan"));
    expect(tspans.length).toBeLessThanOrEqual(PREVIEW_MAX_LINES);
    const lines = [text.firstChild?.textContent ?? "", ...tspans.map((t) => t.textContent ?? "")];
    expect(lines.join(" ").replace(/\s+/g, " ").trim()).toBe("Stay wild. Stay hydrated.");
  });

  test("renders the headline at the size fitHeadline planned, as a real font-size attribute", () => {
    // The pure function's return value was always asserted — but the attribute itself
    // never was, so the headline silently fell back to the inherited 16px inside the
    // 1080×1920 viewBox. Assert the rendered attribute, not just the plan.
    for (const ratio of ["1:1", "9:16"] as const) {
      const headline = "Stay wild. Stay hydrated.";
      const svg = svgOf(
        <CreativePreview primaryColor="#1473E6" headline={headline} ratio={ratio} />,
      );
      const { textWidth, maxHeight, start, min } = fitArgs(ratio);
      const fit = fitHeadline(headline, textWidth, maxHeight, start, min);
      const text = svg.querySelector("text")!;
      expect(text).not.toBeNull();
      expect(Number(text.getAttribute("font-size"))).toBe(fit.fontSize);
      // The tspans inherit the size from the <text>, so no tspan carries its own.
      for (const tspan of text.querySelectorAll("tspan")) {
        expect(tspan.getAttribute("font-size")).toBeNull();
      }
    }
  });

  test("the type scale is the compositor's: width × 0.06, rounded (C1)", () => {
    // C1: the preview used to scale off the canvas height; the compositor's
    // fitText starts at Math.round(width * 0.06). Assert the rendered attribute.
    for (const ratio of ["1:1", "9:16", "16:9"] as const) {
      const svg = svgOf(<CreativePreview primaryColor="#1473E6" headline="Stay wild" ratio={ratio} />);
      const { width: W } = RATIO_DIMENSIONS[ratio];
      const text = svg.querySelector("text")!;
      expect(Number(text.getAttribute("font-size"))).toBe(
        Math.round(W * CREATIVE_GEOMETRY.headlineTypeWidthFraction),
      );
    }
  });

  test("centres the headline like the compositor's textAlign center (C2)", () => {
    // C2: the compositor only ever centres; the preview used to left-align —
    // a state the renderer cannot produce. Assert the rendered attributes.
    const svg = svgOf(<CreativePreview primaryColor="#1473E6" headline="Stay wild. Stay hydrated." />);
    const { width: W } = RATIO_DIMENSIONS["1:1"];
    const text = svg.querySelector("text")!;
    expect(text.getAttribute("text-anchor")).toBe("middle");
    expect(Number(text.getAttribute("x"))).toBe(W / 2);
    for (const tspan of text.querySelectorAll("tspan")) {
      expect(Number(tspan.getAttribute("x"))).toBe(W / 2);
    }
  });

  test("the headline is unconditionally #ffffff, legible from the shade layer (C3)", () => {
    // C3: the render is always white; the preview used a theme token that went
    // near-black in light mode. Assert the rendered fill attribute.
    const svg = svgOf(<CreativePreview primaryColor="#1473E6" headline="Stay wild" />);
    expect(svg.querySelector("text")!.getAttribute("fill")).toBe("#ffffff");
  });

  test("subtle tone settles for Regular — the weight the compositor actually renders (D60)", () => {
    // D60: only 400/700 faces are registered, so the compositor's "500" request
    // silently renders Regular. The preview shows what is rendered.
    const subtle = svgOf(<CreativePreview primaryColor="#1473E6" tone="subtle" headline="Stay wild" />);
    const bold = svgOf(<CreativePreview primaryColor="#1473E6" tone="bold" headline="Stay wild" />);
    expect(Number(subtle.querySelector("text")!.getAttribute("font-weight"))).toBe(400);
    expect(Number(bold.querySelector("text")!.getAttribute("font-weight"))).toBe(700);
  });

  describe("the anchor axis (T4)", () => {
    const H = RATIO_DIMENSIONS["1:1"].height;
    const W = RATIO_DIMENSIONS["1:1"].width;
    const fontSize = Math.round(W * CREATIVE_GEOMETRY.headlineTypeWidthFraction);
    const headlineOf = (svg: SVGSVGElement): SVGTextElement => svg.querySelector("text")!;
    const baselineOf = (svg: SVGSVGElement): number => Number(headlineOf(svg).getAttribute("y"));

    test("an absent anchor derives from layout — the pre-axis behaviour", () => {
      // Bottom layout with no anchor: the block's last baseline sits at the
      // bottom edge fraction — the compositor's own derived rule.
      const bottom = svgOf(<CreativePreview primaryColor="#1473E6" layout="headline-bottom" headline="Stay wild" />);
      expect(baselineOf(bottom)).toBe(H - H * CREATIVE_GEOMETRY.headlineAnchor.bottom);
      // Top layout with no anchor: block top + the 0.75em ascent convention.
      const top = svgOf(<CreativePreview primaryColor="#1473E6" layout="headline-top" headline="Stay wild" />);
      expect(baselineOf(top)).toBe(H * CREATIVE_GEOMETRY.headlineAnchor.top + fontSize * 0.75);
    });

    test("anchor middle centres the wrapped block (rendered arithmetic, not a class assertion)", () => {
      const svg = svgOf(
        <CreativePreview primaryColor="#1473E6" layout="headline-bottom" anchor="middle" headline="Stay wild" />,
      );
      const text = headlineOf(svg);
      expect(Number(text.getAttribute("y"))).toBe(
        H * PREVIEW_ANCHOR_MIDDLE - fontSize / 2 + fontSize * 0.75,
      );
      // One line: the block's box midpoint is the canvas centre (zero insets here).
      const span = 0;
      const blockMidpoint = Number(text.getAttribute("y")) - fontSize * 0.75 + (span + fontSize) / 2;
      expect(blockMidpoint).toBe(H * 0.5);
    });

    test("anchor top and bottom pin the block to the leaf's edge fractions", () => {
      const top = svgOf(<CreativePreview primaryColor="#1473E6" anchor="top" headline="Stay wild" />);
      expect(baselineOf(top)).toBe(H * PREVIEW_ANCHOR_TOP + fontSize * 0.75);
      const bottom = svgOf(<CreativePreview primaryColor="#1473E6" anchor="bottom" headline="Stay wild" />);
      expect(baselineOf(bottom)).toBe(H - H * PREVIEW_ANCHOR_BOTTOM);
    });

    test("the anchor moves the text but never the accent band (the band stays layout's)", () => {
      const svg = svgOf(
        <CreativePreview primaryColor="#1473E6" layout="headline-bottom" anchor="middle" />,
      );
      // headline-bottom: the solid band stays flush to the bottom edge.
      expect(Number(bandRect(svg).getAttribute("y"))).toBe(H - H * CREATIVE_GEOMETRY.accentSolidHeightFraction);
    });
  });

  test("draws the logo block at the compositor's geometry, opposite the headline (C4)", () => {
    const { width: W, height: H } = RATIO_DIMENSIONS["1:1"];
    const logoW = W * CREATIVE_GEOMETRY.logoWidthFraction;
    const margin = W * CREATIVE_GEOMETRY.logoMarginFraction;

    // Top headline → the logo rests bottom-left (prepare's corner assignment).
    const top = svgOf(<CreativePreview primaryColor="#1473E6" layout="headline-top" />);
    const topLogo = logoRect(top);
    expect(Number(topLogo.getAttribute("width"))).toBe(logoW);
    expect(Number(topLogo.getAttribute("height"))).toBe(logoW);
    expect(Number(topLogo.getAttribute("x"))).toBe(margin);
    expect(Number(topLogo.getAttribute("y"))).toBe(H - logoW - margin);

    // Bottom headline → top-right.
    const bottom = svgOf(<CreativePreview primaryColor="#1473E6" layout="headline-bottom" />);
    const bottomLogo = logoRect(bottom);
    expect(Number(bottomLogo.getAttribute("x"))).toBe(W - logoW - margin);
    expect(Number(bottomLogo.getAttribute("y"))).toBe(margin);
  });

  test("an empty headline leaves the text layer empty and the logo at its rest pose", () => {
    const { width: W, height: H } = RATIO_DIMENSIONS["1:1"];
    const svg = svgOf(<CreativePreview primaryColor="#1473E6" />);
    expect(svg.querySelector("text")).toBeNull();
    const margin = W * CREATIVE_GEOMETRY.logoMarginFraction;
    const logoW = W * CREATIVE_GEOMETRY.logoWidthFraction;
    expect(Number(logoRect(svg).getAttribute("y"))).toBe(H - logoW - margin);
  });

  describe("resolveOverlappingLogoY (the compositor's snap, on preview line metrics)", () => {
    const logo = { x: 864, width: 173, height: 173 };
    const H = RATIO_DIMENSIONS["1:1"].height;
    const margin = RATIO_DIMENSIONS["1:1"].width * CREATIVE_GEOMETRY.logoMarginFraction;

    test("a top headline's logo RESTS margined at the bottom edge", () => {
      expect(resolveOverlappingLogoY(undefined, logo, H, true, margin)).toBe(H - logo.height - margin);
    });

    test("a bottom headline's logo RESTS margined at the top edge", () => {
      expect(resolveOverlappingLogoY(undefined, logo, H, false, margin)).toBe(margin);
    });

    test("a headline overlapping the rest pose snaps the logo FLUSH to the far edge", () => {
      // Parity fix (qodo, PR #171): the compositor's snap targets are the safe-inset
      // edges — flush, no margin — while only the REST pose is margined. These
      // previously asserted margined snap positions, pinning the divergence.
      // Top headline: margined bottom rest overlaps; bottom-flush overlaps too;
      // the logo lands flush at the TOP edge (y = 0).
      const overlapping = { x: 0, y: H - 300, width: 1080, height: 300 };
      expect(resolveOverlappingLogoY(overlapping, logo, H, true, margin)).toBe(0);
      // Bottom headline, mirrored: flush at the BOTTOM edge.
      const fromBelow = { x: 0, y: 0, width: 1080, height: 300 };
      expect(resolveOverlappingLogoY(fromBelow, logo, H, false, margin)).toBe(H - logo.height);
    });

    test("a headline grazing only the margined rest snaps flush at the SAME edge", () => {
      // The margin is the whole difference between rest and flush, so a headline can
      // overlap the margined rest box while the flush box below it stays clear —
      // the compositor then keeps the edge and merely drops the margin.
      const grazing = { x: 0, y: H - logo.height - margin - 10, width: 1080, height: 40 };
      expect(resolveOverlappingLogoY(grazing, logo, H, true, margin)).toBe(H - logo.height);
    });

    test("a headline blocking both edges gives up at the flush rest edge", () => {
      const everywhere = { x: 0, y: 0, width: 1080, height: H };
      expect(resolveOverlappingLogoY(everywhere, logo, H, true, margin)).toBe(H - logo.height);
    });

    test("a headline clear of the rest pose never moves the logo", () => {
      // Mid-canvas: overlapping neither the top-edge nor the bottom-edge pose.
      const clear = { x: 0, y: 400, width: 1080, height: 300 };
      expect(resolveOverlappingLogoY(clear, logo, H, true, margin)).toBe(H - logo.height - margin);
      expect(resolveOverlappingLogoY(clear, logo, H, false, margin)).toBe(margin);
    });
  });

  test.each([
    ["ken-burns-in", "kf-ken-burns-in", "g"],
    ["ken-burns-out", "kf-ken-burns-out", "g"],
    ["headline-rise", "kf-headline-rise", "g"],
    ["accent-wipe", "kf-accent-wipe", "rect"],
  ] as const)("motion %s animates the %s keyframe once, forwards-filled, on the %s group", (motion, keyframe, tag) => {
    const svg = svgOf(<CreativePreview primaryColor="#1473E6" motion={motion} />);
    const target = Array.from(svg.querySelectorAll(tag)).find(
      (el) => el.getAttribute("class")?.includes(keyframe),
    );
    expect(target).toBeTruthy();
    expect(target!.getAttribute("class")).toContain("motion-safe:animate-[");
    // D50: one iteration holding its final frame — the fill-mode lives in this
    // class, never in globals.css (whose keyframes the glyph loops share).
    expect(target!.getAttribute("class")).toContain("_forwards]");
    expect(target!.getAttribute("class")).not.toContain("infinite");
  });

  test("without motion the preview is a still: no animation class, no keyframe", () => {
    const svg = svgOf(<CreativePreview primaryColor="#1473E6" />);
    const animated = Array.from(svg.querySelectorAll<SVGElement>("[class]")).filter((el) =>
      (el.getAttribute("class") ?? "").includes("animate-["),
    );
    expect(animated).toHaveLength(0);
  });

  test.each(["1:1", "9:16", "16:9"] as const)(
    "a 60-character unbroken string stays inside the text block at ratio %s",
    (ratio) => {
      const unbroken = "A".repeat(60);
      const svg = svgOf(<CreativePreview primaryColor="#1473E6" headline={unbroken} ratio={ratio} />);
      const { textWidth, maxHeight, start, min } = fitArgs(ratio);

      const fit = fitHeadline(unbroken, textWidth, maxHeight, start, min);
      const floorChars = Math.max(1, Math.floor(textWidth / (CHAR_WIDTH_RATIO * min)));

      expect(fit.lines.length).toBeGreaterThan(0);
      for (const line of fit.lines) {
        expect(line.length).toBeLessThanOrEqual(floorChars);
        const estimatedLineWidth = line.length * CHAR_WIDTH_RATIO * fit.fontSize;
        expect(estimatedLineWidth).toBeLessThanOrEqual(textWidth);
      }

      const text = svg.querySelector("text")!;
      expect(text).not.toBeNull();
      const renderedLines = [
        text.firstChild?.textContent ?? "",
        ...Array.from(text.querySelectorAll("tspan")).map((t) => t.textContent ?? ""),
      ].filter((l) => l.length > 0);
      expect(renderedLines.length).toBeGreaterThan(0);
      for (const line of renderedLines) {
        expect(line.length).toBeLessThanOrEqual(floorChars);
      }
    },
  );
});
