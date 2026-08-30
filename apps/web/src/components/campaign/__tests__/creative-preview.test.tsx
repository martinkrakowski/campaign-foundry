import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { RATIO_DIMENSIONS } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import {
  CreativePreview,
  PREVIEW_MAX_LINES,
  PREVIEW_FONT_RATIO,
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

  test("a word longer than the budget sits on its own line", () => {
    expect(wrapHeadline("supercalifragilistic spirit", 7)).toEqual(["supercalifragilistic", "spirit"]);
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
    const fit = fitHeadline("Stay wild and stay hydrated under the open sky", 700, 600, 200);
    expect(fit.lines.length).toBeLessThanOrEqual(PREVIEW_MAX_LINES);
    expect(fit.fontSize).toBeLessThan(200);
    expect(fit.lines.flatMap((l) => l.split(" ")).join(" ")).toBe(
      "Stay wild and stay hydrated under the open sky",
    );
  });

  test("a single over-long word still ends up on a line, shrinking only for height", () => {
    const fit = fitHeadline("supercalifragilistic", 100, 100, 200);
    expect(fit.lines).toEqual(["supercalifragilistic"]);
    expect(fit.fontSize).toBeLessThan(200);
    expect(fit.fontSize * 1.08).toBeLessThanOrEqual(100);
  });

  test("blank headline fits with no lines", () => {
    const fit = fitHeadline("   ", 700, 800, 170);
    expect(fit.lines).toEqual([]);
    expect(fit.fontSize).toBe(170);
  });

  test("a block too shallow for even a floor-sized headline falls off the floor", () => {
    // maxHeight below one floor-sized line can never satisfy — the loop must give up.
    const fit = fitHeadline("a b c d e", 500, 3, 100);
    expect(fit.lines).toEqual(["a b c d e"]);
    expect(fit.fontSize).toBeLessThan(100 * PREVIEW_FONT_RATIO);
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
});