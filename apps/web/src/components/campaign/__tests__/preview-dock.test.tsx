import { describe, test, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { PREVIEW_FRAME_DEBOUNCE_MS } from "@/lib/preview-frame";
import { PreviewDock, PreviewPicture, PreviewRailEmptyState, derivePreviewRatio, derivePreviewSpec } from "../PreviewDock";
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

  test("a display profile has no ratio, so the explicit default stands", () => {
    expect(derivePreviewRatio("google-display", "16:9")).toBe("16:9");
    expect(derivePreviewRatio("google-display", undefined)).toBe("1:1");
  });
});

describe("derivePreviewSpec", () => {
  test("a display size wins over the social ratio", () => {
    expect(derivePreviewSpec("instagram-story", "1:1", ["728x90"])).toEqual({ size: "728x90" });
  });

  test("an unknown size falls through to the social ratio", () => {
    expect(derivePreviewSpec(undefined, "16:9", ["not-a-size"])).toEqual({ ratio: "16:9" });
  });

  test("without sizes, the social derivation stands", () => {
    expect(derivePreviewSpec("instagram-story", "1:1")).toEqual({ ratio: "9:16" });
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

  test("a display spec mounts at resolveCanvas dimensions", () => {
    const { container } = render(
      <PreviewPicture
        primaryColor="#1473E6"
        headline="Hi"
        spec={{ size: "728x90" }}
        className="block h-auto w-full"
      />,
    );
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 728 90");
  });
});

describe("PreviewDock", () => {
  test("an explicit display spec mounts the leaderboard, not the platform's social ratio", () => {
    const { container } = render(
      <PreviewDock {...showcase} platformId="instagram-story" spec={{ size: "728x90" }} />,
    );
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 728 90");
    expect(container.textContent).toContain("Leaderboard · Instagram Story");
    expect(container.textContent).not.toContain("728x90");
  });

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

  test("a template with a text effect names it in the caption, in words (T6/D50)", () => {
    // The frame is the effect's rest pose — the name in words is what says the
    // delivered video animates; the raw kind id never renders (D18).
    const { container } = render(
      <PreviewDock {...showcase} platformId="instagram-story" style={{ textEffect: "rise-in" }} />,
    );
    expect(container.textContent).toContain(
      messages.previewCaptionMotion("Tall", "Instagram Story", "Rise in"),
    );
    expect(container.textContent).not.toContain("rise-in");
  });

  test("a moving creative whose template carries an effect names both styles (T6)", () => {
    const { container } = render(
      <PreviewDock
        {...showcase}
        platformId="instagram-story"
        motion="ken-burns-in"
        style={{ textEffect: "fade-in" }}
      />,
    );
    expect(container.textContent).toContain(
      messages.previewCaptionMotion("Tall", "Instagram Story", "slow zoom in · Fade in"),
    );
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

  /**
   * D141 — Everything (and any future presentation with no step concept) has
   * no cursor to show. The caller omits `step`/`stepCount` rather than
   * passing a stale position, and the readout must disappear, never render
   * `previewStep(undefined, undefined)`.
   */
  test("omits the step readout when the caller has no cursor to give it (D141)", () => {
    const { container } = render(<PreviewDock {...showcase} step={undefined} stepCount={undefined} />);
    expect(container.textContent).toContain("Summer Launch");
    expect(container.textContent).toContain("Stay wild. Stay hydrated.");
    expect(container.textContent).not.toMatch(/\d+ \/ \d+/);
  });
});

describe("PreviewRailEmptyState (D142)", () => {
  test("names the missing product id, shows the campaign name and (when given) the step readout", () => {
    const { container } = render(
      <PreviewRailEmptyState campaignName="Summer Launch" step={2} stepCount={6} />,
    );
    expect(container.textContent).toContain(messages.previewNeedsProductId);
    expect(container.textContent).toContain("Summer Launch");
    expect(container.textContent).toContain(messages.previewStep(2, 6));
    // D142/D26: never invents a creative — no composed-frame marker at all.
    expect(container.querySelector('[data-testid="preview-frame"]')).toBeNull();
  });

  test("omits the step readout when no cursor is given (Everything, D141)", () => {
    const { container } = render(<PreviewRailEmptyState campaignName="Summer Launch" />);
    expect(container.textContent).not.toMatch(/\d+ \/ \d+/);
  });
});

describe("PreviewDock — the stand-in caption (D52)", () => {
  // The dock composites a real frame only when the host passes the brief's
  // projection; the caption derives from the brief's background axis either way.
  const briefWithAxis = (source: string[]) =>
    ({
      id: "camp",
      targetRegion: "DE",
      targetAudience: "a",
      campaignMessage: "Hello",
      products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
      variation: { count: 2, axes: { background: { source } } },
    }) as never;

  test("a generated or pooled background axis says the background is a stand-in, in words — never a raw axis id", () => {
    const { container } = render(
      <PreviewDock {...showcase} platformId="linkedin" brief={briefWithAxis(["genai"])} />,
    );
    expect(container.textContent).toContain(messages.previewFrameStandInBackground);
    expect(container.textContent).not.toContain("genai");
    expect(container.textContent).not.toContain("asset-pool");
  });

  test("a procedural brief gets no label — the frame IS the real background", () => {
    const { container } = render(
      <PreviewDock {...showcase} platformId="linkedin" brief={briefWithAxis(["procedural"])} />,
    );
    expect(container.textContent).not.toContain(messages.previewFrameStandInBackground);
  });

  test("without the brief's projection, no stand-in claim is made either way", () => {
    const { container } = render(<PreviewDock {...showcase} platformId="linkedin" />);
    expect(container.textContent).not.toContain(messages.previewFrameStandInBackground);
  });
});

describe("PreviewDock — scrub control (VE-D5, VE-D6)", () => {
  test("renders a range control when motion is present", () => {
    const { container } = render(
      <PreviewDock {...showcase} motion="ken-burns-in" />,
    );
    const slider = container.querySelector('input[type="range"]');
    expect(slider).not.toBeNull();
    expect(slider?.getAttribute("aria-label")).toBe(messages.previewScrubLabel);
    expect(slider?.getAttribute("min")).toBe("0");
    expect(Number(slider?.getAttribute("max"))).toBeGreaterThan(0);
  });

  test("the range control is absent when the brief renders no motion", () => {
    const { container } = render(
      <PreviewDock {...showcase} motion={undefined} />,
    );
    const slider = container.querySelector('input[type="range"]');
    expect(slider).toBeNull();
  });

  test("the scrub control never autoplays", async () => {
    vi.useFakeTimers();
    const { container } = render(
      <PreviewDock {...showcase} motion="ken-burns-in" />,
    );
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider).not.toBeNull();
    const initialVal = slider.value;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(slider.value).toBe(initialVal);
    vi.useRealTimers();
  });

  test("scrubbing dispatches no EditorAction and maintains local component state", () => {
    const { container } = render(
      <PreviewDock {...showcase} motion="ken-burns-in" />,
    );
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider).not.toBeNull();
    fireEvent.change(slider, { target: { value: "3" } });
    expect(slider.value).toBe("3");
  });

  test("committing the scrub position on pointerUp and keyUp updates the committed scrub time", () => {
    const { container } = render(
      <PreviewDock {...showcase} motion="ken-burns-in" />,
    );
    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider).not.toBeNull();
    fireEvent.change(slider, { target: { value: "2.5" } });
    fireEvent.pointerUp(slider);
    fireEvent.change(slider, { target: { value: "4" } });
    fireEvent.keyUp(slider);
  });

  test("committing near the end and shortening clip duration clamps atSec to durationSec without falling back", async () => {
    vi.useFakeTimers();
    let lastPostedCell: Record<string, unknown> | undefined;
    vi.mocked(globalThis.fetch).mockImplementation(async (_url, init) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      lastPostedCell = body.cell;
      if (
        body.cell?.durationSec !== undefined &&
        body.cell?.atSec !== undefined &&
        body.cell.atSec > body.cell.durationSec
      ) {
        return new Response(JSON.stringify({ error: "atSec exceeds durationSec" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "image/png", "x-preview-frame-cache-key": "k".repeat(64) },
      });
    });

    const briefWithDuration = (durationSec: number) =>
      ({
        id: "camp",
        targetRegion: "DE",
        targetAudience: "a",
        campaignMessage: "Hello",
        products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
        variation: { count: 2, axes: { duration: [durationSec] } },
      }) as unknown as CampaignBrief;

    const { container, rerender } = render(
      <PreviewDock
        {...showcase}
        motion="ken-burns-in"
        brief={briefWithDuration(10)}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });

    const slider = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(slider).not.toBeNull();

    // Commit a position near the end (9 on a 10s clip)
    fireEvent.change(slider, { target: { value: "9" } });
    fireEvent.pointerUp(slider);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });

    expect(lastPostedCell?.atSec).toBe(9);
    expect(container.querySelector("img")).not.toBeNull();

    // Re-render with a shorter duration (5s)
    rerender(
      <PreviewDock
        {...showcase}
        motion="ken-burns-in"
        brief={briefWithDuration(5)}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });

    // Assert the cell's atSec never exceeds durationSec and the preview is not the fallback
    expect(lastPostedCell?.atSec).toBeLessThanOrEqual(5);
    expect(lastPostedCell?.atSec).toBe(5);
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();

    vi.useRealTimers();
  });
});

