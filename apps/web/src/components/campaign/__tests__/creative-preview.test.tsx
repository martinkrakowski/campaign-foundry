import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { RATIO_DIMENSIONS } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import {
  CreativePreview,
  PREVIEW_MAX_LINES,
  PREVIEW_FONT_RATIO,
  PREVIEW_MIN_FONT_RATIO,
  CHAR_WIDTH_RATIO,
  fitHeadline,
  wrapHeadline,
} from "../CreativePreview";
import { LAYERS, times } from "@/components/ui/preview-layers";

const svgOf = (ui: React.ReactNode): SVGSVGElement =>
  render(<div>{ui}</div>).container.querySelector("svg")!;

const bandRect = (svg: SVGSVGElement): SVGElement =>
  Array.from(svg.querySelectorAll("rect")).find((r) => r.getAttribute("class") === "fill-[var(--c)]")!;

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

  test("a deliberately long headline lands at the floor (PREVIEW_MIN_FONT_RATIO * H) and not beneath it", () => {
    const longHeadline =
      "This is a deliberately very long headline that exceeds three lines at any size and must land exactly at the floor";
    const { height: H, width: W } = RATIO_DIMENSIONS["1:1"];
    const textEdge = times(LAYERS.textEdge, W);
    const textWidth = W - 2 * textEdge;
    const anchor = times(LAYERS.headlineAnchor, H);
    const maxHeight = H - 2 * anchor;
    const fit = fitHeadline(longHeadline, textWidth, maxHeight, H * PREVIEW_FONT_RATIO, H * PREVIEW_MIN_FONT_RATIO);
    expect(fit.fontSize).toBe(H * PREVIEW_MIN_FONT_RATIO);
    expect(fit.fontSize / H).toBeCloseTo(PREVIEW_MIN_FONT_RATIO, 5);
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
    const band = times(LAYERS.band, H);
    // Top layout: the band sits flush to the top edge (the headline edge).
    expect(Number(bandRect(svg).getAttribute("y"))).toBe(0);
    expect(Number(bandRect(svg).getAttribute("height"))).toBe(band);
  });

  test("bottom layout flushes the band to the bottom edge", () => {
    const svg = svgOf(<CreativePreview primaryColor="#1473E6" layout="headline-bottom" />);
    const { height: H } = RATIO_DIMENSIONS["1:1"];
    expect(Number(bandRect(svg).getAttribute("y"))).toBe(H - times(LAYERS.band, H));
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
    expect(shadeAlphaOf(bold)).toBe(LAYERS.shade.alpha.bold);
    expect(shadeAlphaOf(subtle)).toBe(LAYERS.shade.alpha.subtle);
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
      const { height: H, width: W } = RATIO_DIMENSIONS[ratio];
      const textEdge = times(LAYERS.textEdge, W);
      const anchor = times(LAYERS.headlineAnchor, H);
      const fit = fitHeadline(
        headline,
        W - 2 * textEdge,
        H - 2 * anchor,
        H * PREVIEW_FONT_RATIO,
        H * PREVIEW_MIN_FONT_RATIO,
      );
      const text = svg.querySelector("text")!;
      expect(text).not.toBeNull();
      expect(Number(text.getAttribute("font-size"))).toBe(fit.fontSize);
      // The tspans inherit the size from the <text>, so no tspan carries its own.
      for (const tspan of text.querySelectorAll("tspan")) {
        expect(tspan.getAttribute("font-size")).toBeNull();
      }
    }
  });

  test("subtle tone settles for the lighter headline weight", () => {
    const svg = svgOf(<CreativePreview primaryColor="#1473E6" tone="subtle" headline="Stay wild" />);
    const text = svg.querySelector("text")!;
    expect(Number(text.getAttribute("font-weight"))).toBe(500);
  });

  test("an empty headline leaves the canvas clean", () => {
    const svg = svgOf(<CreativePreview primaryColor="#1473E6" />);
    expect(svg.querySelector("text")).toBeNull();
  });

  test.each([
    ["ken-burns-in", "kf-ken-burns-in", "g"],
    ["ken-burns-out", "kf-ken-burns-out", "g"],
    ["headline-rise", "kf-headline-rise", "g"],
    ["accent-wipe", "kf-accent-wipe", "rect"],
  ] as const)("motion %s animates the %s keyframe once, on the %s group", (motion, keyframe, tag) => {
    const svg = svgOf(<CreativePreview primaryColor="#1473E6" motion={motion} />);
    const target = Array.from(svg.querySelectorAll(tag)).find(
      (el) => el.getAttribute("class")?.includes(keyframe),
    );
    expect(target).toBeTruthy();
    expect(target!.getAttribute("class")).toContain("motion-safe:animate-[");
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
      const { height: H, width: W } = RATIO_DIMENSIONS[ratio];
      const textEdge = times(LAYERS.textEdge, W);
      const textWidth = W - 2 * textEdge;
      const anchor = times(LAYERS.headlineAnchor, H);
      const maxHeight = H - 2 * anchor;

      const fit = fitHeadline(unbroken, textWidth, maxHeight, H * PREVIEW_FONT_RATIO, H * PREVIEW_MIN_FONT_RATIO);
      const floorChars = Math.max(1, Math.floor(textWidth / (CHAR_WIDTH_RATIO * (H * PREVIEW_MIN_FONT_RATIO))));

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