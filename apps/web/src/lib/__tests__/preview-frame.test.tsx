import { describe, test, expect, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { CampaignBrief, PreviewCellSelection } from "@campaignfoundry/CampaignOrchestration";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { PREVIEW_FRAME_DEBOUNCE_MS, usePreviewFrame, briefBackgroundIsStandIn, previewFetchKey } from "../preview-frame";

const brief = (over: Partial<CampaignBrief> = {}): CampaignBrief => ({
  schemaVersion: 1,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id: "camp",
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hello",
  products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
  ...over,
});

const cell = (over: Record<string, unknown> = {}): PreviewCellSelection => ({
  productId: "alpha",
  canvas: { ratio: "9:16" },
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
  test("loading a different brief id clears the old frame to the placeholder immediately", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const { result, rerender } = renderHook(({ id }) => usePreviewFrame(brief({ id }), cell()), {
      initialProps: { id: "camp" },
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS + 10); });
    expect(result.current.frame).not.toBeNull();

    // A saved brief whose id changes is a different creative: the previous
    // brief's frame must not survive even for the debounce window.
    rerender({ id: "camp-b" });
    expect(result.current.frame).toBeNull();
    expect(result.current.failed).toBe(false);
  });

  test.each([
    ["product", { productId: "beta" }],
    ["ratio", { canvas: { ratio: "1:1" } }],
    ["layout", { layout: "headline-top" }],
  ] as const)(
    "switching the previewed cell (%s) clears to the placeholder immediately",
    async (_axis, over) => {
      vi.useFakeTimers();
      vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
      const { result, rerender } = renderHook(
        ({ next }) => usePreviewFrame(brief(), cell(next)),
        { initialProps: { next: {} as Record<string, unknown> } },
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS + 10); });
      expect(result.current.frame).not.toBeNull();

      rerender({ next: over });
      expect(result.current.frame).toBeNull();
      expect(result.current.failed).toBe(false);
    },
  );

  test("a re-slug of a not-yet-saved draft keeps the last frame when keyed by the draft identity", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const { result, rerender } = renderHook(
      ({ id }) => usePreviewFrame(brief({ id }), cell(), "new"),
      { initialProps: { id: "s" } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS + 10); });
    const first = result.current.frame;
    expect(first).not.toBeNull();

    rerender({ id: "summer" });
    expect(result.current.frame).toBe(first);
  });

  test("a stable draft key still clears when the previewed cell changes", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const { result, rerender } = renderHook(
      ({ layout }) => usePreviewFrame(brief(), cell({ layout }), "new"),
      { initialProps: { layout: "headline-bottom" } },
    );
    await act(async () => { await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS + 10); });
    expect(result.current.frame).not.toBeNull();

    rerender({ layout: "headline-top" });
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

describe("previewFetchKey (CC2)", () => {
  test("is stable across two equal-content briefs that are different object references", () => {
    expect(previewFetchKey(brief(), "alpha")).toBe(previewFetchKey(brief(), "alpha"));
  });

  test("ignores fields the compositor never reads", () => {
    const a = previewFetchKey(brief(), "alpha");
    const b = previewFetchKey(brief({ targetAudience: "different", targetRegion: "FR", id: "other" }), "alpha");
    expect(a).toBe(b);
  });

  test("changes when the previewed product's colour or logo changes", () => {
    const base = previewFetchKey(brief(), "alpha");
    const recoloured = previewFetchKey(
      { ...brief(), products: [{ ...brief().products[0], primaryColor: "#000000" }] },
      "alpha",
    );
    expect(recoloured).not.toBe(base);
  });

  test("an unmatched product id (not yet the previewed one, or removed) carries no product fields", () => {
    expect(previewFetchKey(brief(), "not-a-product")).toBe(previewFetchKey(brief(), undefined));
  });

  test("prefers localizedMessage over campaignMessage — the same fallback the compositor applies", () => {
    const withoutLocalized = previewFetchKey(brief({ campaignMessage: "Hello" }), "alpha");
    const withLocalized = previewFetchKey(brief({ campaignMessage: "Hello", localizedMessage: "Bonjour" }), "alpha");
    expect(withLocalized).not.toBe(withoutLocalized);
    // Two briefs agreeing only on the localized copy must agree on the key,
    // whatever their (unread) campaignMessage says.
    expect(previewFetchKey(brief({ campaignMessage: "Hello", localizedMessage: "Bonjour" }), "alpha")).toBe(
      previewFetchKey(brief({ campaignMessage: "Different", localizedMessage: "Bonjour" }), "alpha"),
    );
  });

  test("changes when message, style, template, output.platforms/sizes, copy.timeline or the background/duration axes change", () => {
    const base = previewFetchKey(brief(), "alpha");
    expect(previewFetchKey(brief({ campaignMessage: "New" }), "alpha")).not.toBe(base);
    expect(previewFetchKey(brief({ style: { fontFamily: "Lora" } }), "alpha")).not.toBe(base);
    expect(
      previewFetchKey({ ...brief(), template: { ...brief().template, layers: [] } }, "alpha"),
    ).not.toBe(base);
    expect(previewFetchKey({ ...brief(), output: { formats: ["static"], platforms: ["linkedin"] } }, "alpha")).not.toBe(base);
    expect(previewFetchKey({ ...brief(), output: { formats: ["static"], platforms: [], sizes: ["728x90"] } }, "alpha")).not.toBe(base);
    expect(
      previewFetchKey(
        {
          ...brief(),
          copy: { timeline: { beats: [{ text: "hi", weight: 1 }], transition: "cut", keyBeat: 1 } },
        } as CampaignBrief,
        "alpha",
      ),
    ).not.toBe(base);
    expect(
      previewFetchKey(
        { ...brief(), variation: { count: 2, axes: { background: { source: ["genai"] } } } as CampaignBrief["variation"] },
        "alpha",
      ),
    ).not.toBe(base);
    expect(
      previewFetchKey({ ...brief(), variation: { count: 2, axes: { duration: [6] } } as CampaignBrief["variation"] }, "alpha"),
    ).not.toBe(base);
  });
});

describe("usePreviewFrame — the fetch keys on what the frame depends on, not brief identity (CC2)", () => {
  /**
   * The defect CC2 closes: `request` used to depend on `brief` by object
   * IDENTITY (`preview-frame.ts:83`, verified at `origin/main` `64d715b8`).
   * `toBrief(state)` builds a brand-new brief object on every keystroke
   * (`BriefEditor.tsx:589`), so a field the compositor never reads —
   * `targetAudience`/`targetRegion` ride the brief only as
   * `BackgroundContext` metadata the wired `ProceduralBackgroundGenerator`
   * ignores entirely (`ProceduralBackgroundGenerator.ts:22-26`: only
   * `product.primaryColor`, the ratio and a `paletteShift` this route never
   * sets) — still fired a fresh fetch. A brief that is a NEW OBJECT but
   * unchanged in every field the frame actually reads must not refetch.
   */
  test("a new brief reference with only targetAudience/targetRegion changed does not refetch", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const { rerender } = renderHook(({ b }) => usePreviewFrame(b, cell()), {
      initialProps: { b: brief() },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // A brand-new object (never `===` the first) with only metadata fields touched.
    rerender({ b: brief({ targetAudience: "a whole new paragraph", targetRegion: "FR" }) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS * 2);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1); // still one — no wasted request
  });

  test.each([
    ["the previewed product's colour", (b: CampaignBrief) => ({ ...b, products: [{ ...b.products[0], primaryColor: "#000000" }] })],
    ["the previewed product's logo", (b: CampaignBrief) => ({ ...b, products: [{ ...b.products[0], logoPath: "new.png" }] })],
    ["the campaign message (the compositor's `message`)", (b: CampaignBrief) => ({ ...b, campaignMessage: "New headline" })],
    ["the template", (b: CampaignBrief) => ({ ...b, template: { ...b.template, layers: [] } })],
  ] as const)(
    "a new brief reference that changes %s DOES refetch",
    async (_label, change) => {
      vi.useFakeTimers();
      vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
      const { rerender } = renderHook(({ b }) => usePreviewFrame(b, cell()), {
        initialProps: { b: brief() },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);

      rerender({ b: change(brief()) });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS * 2);
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    },
  );

  test("a request actually sent still carries the CURRENT full brief, not a stale projection", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const { rerender } = renderHook(({ b }) => usePreviewFrame(b, cell()), {
      initialProps: { b: brief() },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });

    // A look-preserving change (ignored by the fetch key) rides along on the
    // NEXT real fetch — the key skips wasted requests, it does not truncate
    // what a request that DOES fire actually sends.
    const withAudience = brief({ targetAudience: "new", campaignMessage: "Changed" });
    rerender({ b: withAudience });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS * 2);
    });
    const bodies = vi.mocked(globalThis.fetch).mock.calls.map(
      ([, init]) => JSON.parse((init as RequestInit).body as string) as { brief: CampaignBrief },
    );
    expect(bodies[1].brief).toEqual(withAudience);
  });
});

describe("usePreviewFrame — scrub cell fields (VE2)", () => {
  test("passes motion, durationSec and atSec in the cell when present", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    renderHook(() =>
      usePreviewFrame(
        brief(),
        cell({ motion: "ken-burns-in", durationSec: 6, atSec: 2 }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.cell).toMatchObject({
      motion: "ken-burns-in",
      durationSec: 6,
      atSec: 2,
    });
  });

  test("changing atSec refetches the frame", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const stableBrief = brief();
    const { rerender } = renderHook(
      ({ atSec }) =>
        usePreviewFrame(
          stableBrief,
          cell({ motion: "ken-burns-in", durationSec: 6, atSec }),
        ),
      { initialProps: { atSec: 1 } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    rerender({ atSec: 4 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    const [, secondInit] = vi.mocked(globalThis.fetch).mock.calls[1];
    const body = JSON.parse((secondInit as RequestInit).body as string);
    expect(body.cell.atSec).toBe(4);
  });
});

