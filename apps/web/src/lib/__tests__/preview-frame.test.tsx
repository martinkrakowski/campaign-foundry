import { describe, test, expect, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { CampaignBrief, PreviewCellSelection } from "@campaignfoundry/CampaignOrchestration";
import { PREVIEW_FRAME_DEBOUNCE_MS, usePreviewFrame, briefBackgroundIsStandIn } from "../preview-frame";

const brief = (over: Partial<CampaignBrief> = {}): CampaignBrief => ({
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hello",
  products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
  ...over,
});

const cell = (over: Record<string, unknown> = {}): PreviewCellSelection => ({
  productId: "alpha",
  ratio: "9:16",
  layout: "headline-bottom",
  tone: "bold",
  ...over,
} as PreviewCellSelection);

/** Fake PNG bytes (any bytes work — the hook base64s whatever the route answers). */
const pngBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
const pngResponse = (cacheKey = "a".repeat(64)) =>
  new Response(pngBytes, {
    status: 200,
    headers: { "content-type": "image/png", "x-preview-frame-cache-key": cacheKey },
  });

/** A deferred fetch: each call hands back the next promise the test controls. */
const deferredFetch = (): { calls: Array<{ url: string; signal: AbortSignal; body: unknown }>; settle: (p: Promise<Response>) => void } => {
  const calls: Array<{ url: string; signal: AbortSignal; body: unknown }> = [];
  const resolvers: Array<(p: Promise<Response>) => void> = [];
  vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
    calls.push({
      url: String(url),
      signal: (init as RequestInit).signal as AbortSignal,
      body: JSON.parse((init as RequestInit).body as string),
    });
    return new Promise<Response>((resolve, reject) => {
      resolvers.push((p) => p.then(resolve, reject));
    });
  });
  return { calls, settle: (p) => resolvers.shift()!(p) };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("usePreviewFrame — the debounced, cancellable fetch", () => {
  test("waits out the debounce, then posts the brief and cell to the preview route", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const { result } = renderHook(() => usePreviewFrame(brief(), cell()));

    await act(async () => {
      // Well inside the debounce window (an edit burst), nothing may have been sent yet.
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe("/api/pipeline/campaigns/preview-frame");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ brief: brief(), cell: cell() });
    expect(result.current.frame).not.toBeNull();
    expect(result.current.failed).toBe(false);
  });

  test("the arriving frame becomes a data URL tagged with the route's cache key", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse("cafe"));
    const { result } = renderHook(() => usePreviewFrame(brief(), cell()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(result.current.frame?.cacheKey).toBe("cafe");
    expect(result.current.frame?.dataUrl).toBe(`data:image/png;base64,${btoa(String.fromCharCode(...pngBytes))}`);
  });

  test("a look change inside the debounce window replaces the pending request — one fetch for the final look", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const { rerender } = renderHook(({ tone }) => usePreviewFrame(brief(), cell({ tone })), {
      initialProps: { tone: "bold" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    rerender({ tone: "subtle" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(JSON.parse((init as RequestInit).body as string).cell.tone).toBe("subtle");
  });

  test("an in-flight request is aborted the moment the look changes", async () => {
    vi.useFakeTimers();
    const deferred = deferredFetch();
    const { rerender } = renderHook(({ tone }) => usePreviewFrame(brief(), cell({ tone })), {
      initialProps: { tone: "bold" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(deferred.calls).toHaveLength(1);
    rerender({ tone: "subtle" });
    expect(deferred.calls[0].signal.aborted).toBe(true); // superseded before it could answer
  });

  test("a frame that arrives after its look was replaced is discarded", async () => {
    vi.useFakeTimers();
    const deferred = deferredFetch();
    const { result, rerender } = renderHook(({ tone }) => usePreviewFrame(brief(), cell({ tone })), {
      initialProps: { tone: "bold" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    rerender({ tone: "subtle" });
    await act(async () => {
      deferred.settle(Promise.resolve(pngResponse()));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.frame).toBeNull(); // the stale frame never shows
  });

  test("a rejection after the look was replaced does not read as a failure of the new look", async () => {
    vi.useFakeTimers();
    const deferred = deferredFetch();
    const { result, rerender } = renderHook(({ tone }) => usePreviewFrame(brief(), cell({ tone })), {
      initialProps: { tone: "bold" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    rerender({ tone: "subtle" });
    await act(async () => {
      deferred.settle(Promise.reject(new Error("aborted")));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.failed).toBe(false);
    expect(result.current.frame).toBeNull();
  });

  test("a failed request keeps the placeholder standing: no frame, failed true", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("route down"));
    const { result } = renderHook(() => usePreviewFrame(brief(), cell()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(result.current.frame).toBeNull();
    expect(result.current.failed).toBe(true);
  });

  test("a non-ok answer is a failure, not a frame", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response("nope", { status: 500 }));
    const { result } = renderHook(() => usePreviewFrame(brief(), cell()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(result.current.frame).toBeNull();
    expect(result.current.failed).toBe(true);
  });

  test("a response without the cache-key header still renders, with an empty key", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(new Response(pngBytes, { status: 200 }));
    const { result } = renderHook(() => usePreviewFrame(brief(), cell()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(result.current.frame?.cacheKey).toBe("");
  });

  test("without a brief or an incomplete cell, nothing is ever requested", async () => {
    vi.useFakeTimers();
    const nothing = renderHook(() => usePreviewFrame(undefined, cell()));
    const lookless = renderHook(() => usePreviewFrame(brief(), undefined));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS * 10);
    });
    expect(nothing.result.current.frame).toBeNull();
    expect(lookless.result.current.frame).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("briefBackgroundIsStandIn (D52)", () => {
  test("a genai or asset-pool background axis is a stand-in; procedural is the real background", () => {
    const withAxes = (source: unknown) =>
      brief({ variation: { count: 2, axes: { background: { source } } } as CampaignBrief["variation"] });
    expect(briefBackgroundIsStandIn(withAxes(["genai"]))).toBe(true);
    expect(briefBackgroundIsStandIn(withAxes(["procedural", "genai"]))).toBe(true);
    expect(briefBackgroundIsStandIn(withAxes(["asset-pool"]))).toBe(true);
    expect(briefBackgroundIsStandIn(withAxes(["procedural"]))).toBe(false);
    expect(briefBackgroundIsStandIn(withAxes(undefined))).toBe(false);
    expect(briefBackgroundIsStandIn(withAxes("genai"))).toBe(false); // not an axis list
    expect(briefBackgroundIsStandIn(brief())).toBe(false); // no variation block at all
  });
});

describe("identity-scoped frame retention (the stale-frame finding on PR #177)", () => {
  test("a brief switch clears the old frame to the placeholder immediately", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const { result, rerender } = renderHook(({ id }) => usePreviewFrame(brief({ id }), cell()), {
      initialProps: { id: "camp" },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS + 10); });
    expect(result.current.frame).not.toBeNull();

    // Which creative is previewed changed: the previous brief's frame must not
    // survive even for the debounce window.
    rerender({ id: "camp-b" });
    expect(result.current.frame).toBeNull();
    expect(result.current.failed).toBe(false);
  });

  test("an identity-preserving rerender keeps the last frame (no flicker per keystroke)", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const { result, rerender } = renderHook(({ id }) => usePreviewFrame(brief({ id }), cell()), {
      initialProps: { id: "camp" },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS + 10); });
    const first = result.current.frame;
    expect(first).not.toBeNull();

    // Same brief, same cell — a plain rerender (a keystroke elsewhere) keeps the frame.
    rerender({ id: "camp" });
    expect(result.current.frame).toBe(first);
  });
});
