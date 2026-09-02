import { describe, test, expect, afterEach, vi } from "vitest";
import { render, act } from "@testing-library/react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { PreviewFrame } from "../PreviewFrame";
import { PREVIEW_FRAME_DEBOUNCE_MS } from "@/lib/preview-frame";

const brief = (over: Partial<CampaignBrief> = {}): CampaignBrief => ({
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hello",
  products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
  ...over,
});

const pngBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
const pngResponse = () =>
  new Response(pngBytes, {
    status: 200,
    headers: { "content-type": "image/png", "x-preview-frame-cache-key": "k".repeat(64) },
  });

const renderFrame = (props: Partial<Parameters<typeof PreviewFrame>[0]> = {}) =>
  render(
    <PreviewFrame
      brief={brief()}
      layout="headline-bottom"
      tone="bold"
      primaryColor="#1473E6"
      headline="Hello"
      ratio="9:16"
      className="block h-auto w-full"
      {...props}
    />,
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("PreviewFrame (D52)", () => {
  test("renders the SVG placeholder synchronously — no frame, no empty box", () => {
    const { container } = renderFrame();
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  test("swaps to the real frame when the route answers: an img at the same box, the SVG gone", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const { container } = renderFrame();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    const img = container.querySelector("img")!;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...pngBytes))}`);
    expect(img.className).toBe("block h-auto w-full");
    expect(container.querySelector("svg")).toBeNull();
    // The real frame lives in the same bordered box the placeholder drew.
    expect(img.parentElement?.className).toContain("overflow-hidden rounded-lg border");
  });

  test("on error the SVG placeholder stands — never a broken-image state", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("route down"));
    const { container } = renderFrame();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  test.each([
    ["no brief at all", { brief: undefined }],
    ["a brief without products", { brief: brief({ products: [] }) }],
    ["a product with an empty id", { brief: brief({ products: [{ id: "", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }] }) }],
    ["no layout", { layout: undefined }],
    ["no tone", { tone: undefined }],
  ])("with %s, the look is unspecified and nothing is ever requested", async (_label, props) => {
    vi.useFakeTimers();
    const { container } = renderFrame(props);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS * 5);
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(container.querySelector("svg")).not.toBeNull();
  });

  test("a blank product id never fetches; naming the product fires the request", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const view = renderFrame({
      brief: brief({ products: [{ id: "", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }] }),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();

    view.rerender(
      <PreviewFrame
        brief={brief()}
        layout="headline-bottom"
        tone="bold"
        primaryColor="#1473E6"
        headline="Hello"
        ratio="9:16"
        className="block h-auto w-full"
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("the cell request carries the anchor only when one is set", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const withAnchor = renderFrame({ anchor: "top" });
    const withoutAnchor = renderFrame();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    const bodies = vi
      .mocked(globalThis.fetch)
      .mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).cell);
    expect(bodies[0].anchor).toBe("top");
    expect("anchor" in bodies[1]).toBe(false);
    withAnchor.unmount();
    withoutAnchor.unmount();
  });
});
