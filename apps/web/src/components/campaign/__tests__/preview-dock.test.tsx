import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { PreviewDock, PreviewPicture, derivePreviewRatio } from "../PreviewDock";
import * as messages from "../messages";

const showcase = {
  campaignName: "Summer Launch",
  headline: "Stay wild. Stay hydrated.",
  primaryColor: "#1473E6",
  layout: "headline-bottom" as const,
  tone: "bold" as const,
  step: 2,
  stepCount: 6,
};

describe("derivePreviewRatio", () => {
  test("the platform's own ratio wins over the explicit ratio", () => {
    expect(derivePreviewRatio("instagram-story", "1:1")).toBe("9:16");
    expect(derivePreviewRatio("instagram-feed", "16:9")).toBe("1:1");
    expect(derivePreviewRatio("linkedin", undefined)).toBe("1:1");
  });

  test("without a platform, the explicit ratio stands", () => {
    expect(derivePreviewRatio(undefined, "16:9")).toBe("16:9");
  });

  test("without either, a square is the default", () => {
    expect(derivePreviewRatio(undefined, undefined)).toBe("1:1");
  });

  test("an unknown platform falls through to the explicit default", () => {
    expect(derivePreviewRatio("not-a-platform", "9:16")).toBe("9:16");
    expect(derivePreviewRatio("not-a-platform", undefined)).toBe("1:1");
  });
});

describe("PreviewPicture", () => {
  test("draws the final ratio it is handed — it never derives again", () => {
    // §6 question 4's trap, pinned: the caller derives once (the dock from the
    // platform, the Review figure before it ever calls) and this passes the RESULT
    // through. A second derivation here would need a platform it is not given —
    // so a final 16:9 must reach the canvas as exactly 16:9.
    const { container } = render(
      <PreviewPicture primaryColor="#1473E6" headline="Hi" ratio="16:9" className="block h-auto w-full" />,
    );
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 1920 1080");
  });
});

describe("PreviewDock", () => {
  test("derives the ratio once, at its own call site: the platform wins over the shape chips", () => {
    const { container } = render(<PreviewDock {...showcase} platformId="instagram-story" ratio="1:1" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 1080 1920");
  });

  test("names the platform and ratio as display labels, never raw values", () => {
    const { container } = render(<PreviewDock {...showcase} platformId="instagram-story" ratio="1:1" />);
    expect(container.textContent).toContain("Tall · Instagram Story");
    expect(container.textContent).not.toContain("9:16");
    expect(container.textContent).not.toContain("instagram-story");
  });

  test("says so when no platform is picked yet", () => {
    const { container } = render(<PreviewDock {...showcase} />);
    expect(container.textContent).toContain("Square · no platform yet");
  });

  test("a moving creative names its video style in the caption, in words (D50)", () => {
    const { container } = render(
      <PreviewDock {...showcase} platformId="instagram-story" motion="ken-burns-in" />,
    );
    expect(container.textContent).toContain(
      messages.previewCaptionMotion("Tall", "Instagram Story", "slow zoom in"),
    );
    // The raw kind id is display-name territory: the words are the caption, the id never is.
    expect(container.textContent).not.toContain("ken-burns-in");
  });

  test("shows the campaign name, headline and step readout", () => {
    const { container } = render(<PreviewDock {...showcase} platformId="linkedin" />);
    expect(container.textContent).toContain("Summer Launch");
    expect(container.textContent).toContain("Stay wild. Stay hydrated.");
    expect(container.textContent).toContain(messages.previewStep(2, 6));
  });

  test("the legend renders through Eyebrow as a p on the token", () => {
    const { container } = render(<PreviewDock {...showcase} platformId="instagram-story" ratio="1:1" />);
    const legend = container.querySelector("p")!;
    expect(legend.textContent).toBe(messages.previewLegend);
    expect(legend.className).toContain("tracking-eyebrow");
    expect(legend.className).not.toContain("tracking-widest");
  });

  test("a headline-less brief shows name and step only", () => {
    const { container } = render(<PreviewDock {...showcase} headline={undefined} />);
    expect(container.textContent).toContain("Summer Launch");
    expect(container.textContent).not.toContain("Stay wild");
  });
});
