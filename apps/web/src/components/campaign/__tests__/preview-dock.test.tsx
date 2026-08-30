import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { PreviewDock, PreviewStrip, derivePreviewRatio } from "../PreviewDock";
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

describe("PreviewDock", () => {
  test("is the desktop rail: hidden below, flex from xl", () => {
    const { container } = render(<PreviewDock {...showcase} platformId="instagram-story" ratio="1:1" />);
    const aside = container.querySelector("aside")!;
    expect(aside.getAttribute("class")).toContain("hidden");
    expect(aside.getAttribute("class")).toContain("xl:flex");
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

  test("shows the campaign name, headline and step readout", () => {
    const { container } = render(<PreviewDock {...showcase} platformId="linkedin" />);
    expect(container.textContent).toContain("Summer Launch");
    expect(container.textContent).toContain("Stay wild. Stay hydrated.");
    expect(container.textContent).toContain(messages.previewStep(2, 6));
  });

  test("renders the preview at the platform ratio, not the shape chips", () => {
    const { container } = render(<PreviewDock {...showcase} platformId="instagram-story" ratio="1:1" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 1080 1920");
  });

  test("a headline-less brief shows name and step only", () => {
    const { container } = render(<PreviewDock {...showcase} headline={undefined} />);
    expect(container.textContent).toContain("Summer Launch");
    expect(container.textContent).not.toContain("Stay wild");
  });
});

describe("PreviewStrip", () => {
  test("is the mobile rail: flex below, hidden from xl", () => {
    const { container } = render(<PreviewStrip {...showcase} platformId="linkedin" />);
    const bar = container.firstElementChild as HTMLElement;
    expect(bar.getAttribute("class")).toContain("flex");
    expect(bar.getAttribute("class")).toContain("xl:hidden");
  });

  test("carries the same caption, name and step as the dock", () => {
    const { container } = render(<PreviewStrip {...showcase} platformId="linkedin" />);
    const text = container.textContent ?? "";
    expect(text).toContain("Square · LinkedIn");
    expect(text).toContain("Summer Launch");
    expect(text).toContain(messages.previewStep(2, 6));
  });
});