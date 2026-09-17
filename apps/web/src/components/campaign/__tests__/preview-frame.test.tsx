import { describe, test, expect, afterEach, vi } from "vitest";
import { useMemo } from "react";
import { render, act } from "@testing-library/react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { PreviewFrame } from "../PreviewFrame";
import { PreviewDock } from "../PreviewDock";
import { previewDockProps, previewRailKey } from "../preview-props";
import { editorReducer, initialEditorState, toBrief, type EditorState } from "../editor-state";
import { PREVIEW_FRAME_DEBOUNCE_MS } from "@/lib/preview-frame";

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

  test("a display-size spec issues exactly one preview request carrying { size: \"728x90\" } and mounts the frame", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const { container } = renderFrame({ spec: { size: "728x90" } });
    // The SVG placeholder stands until the frame arrives — but the request IS issued.
    expect(container.querySelector("svg")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string,
    ) as { cell: { canvas: unknown } };
    expect(body.cell.canvas).toEqual({ size: "728x90" });
    // The real frame replaces the placeholder — the dock's acceptance for a size.
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();
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

  test("the cell request carries motion, durationSec and atSec when motion is active", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    renderFrame({ motion: "ken-burns-in", durationSec: 6, atSec: 2 } as never);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    const body = JSON.parse((vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.cell.motion).toBe("ken-burns-in");
    expect(body.cell.durationSec).toBe(6);
    expect(body.cell.atSec).toBe(2);
  });
});

describe("renaming a fresh draft must not blank the preview frame", () => {
  /**
   * The two halves of the defect: `patch` re-slugs `briefId` on a new draft,
   * and frame identity includes `brief.id`. Typing Campaign Name therefore
   * moves identity per keystroke and the painted `<img>` is replaced by the
   * SVG placeholder — the flicker identity exists to prevent.
   */
  test("on a new draft with a product, typing Campaign Name keeps the last painted frame", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());

    let state = initialEditorState("variation");
    state = editorReducer(state, {
      type: "setProduct",
      key: 1,
      patch: { id: "alpha", name: "Alpha" },
    });
    state = editorReducer(state, { type: "patch", patch: { campaignName: "S" } });
    expect(state.source.kind).toBe("new");
    expect(state.briefId).toBe("s");

    const dock = (next: typeof state) => {
      const props = previewDockProps(next, 0, 6)!;
      return <PreviewDock {...props} brief={toBrief(next)} />;
    };

    const view = render(dock(state));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS + 10);
    });
    const painted = view.container.querySelector("img");
    expect(painted).not.toBeNull();
    expect(view.container.querySelector("svg")).toBeNull();
    const src = painted!.getAttribute("src");

    for (const name of ["Su", "Sum", "Summer"]) {
      state = editorReducer(state, { type: "patch", patch: { campaignName: name } });
      view.rerender(dock(state));
      expect(state.briefId).toBe(name.toLowerCase());
      expect(
        view.container.querySelector("img"),
        `the painted frame must survive typing ${JSON.stringify(name)} (slug ${state.briefId})`,
      ).not.toBeNull();
      expect(view.container.querySelector("svg")).toBeNull();
      expect(view.container.querySelector("img")!.getAttribute("src")).toBe(src);
    }
  });
});

/**
 * `BriefEditor`'s real memo boundary: `railProps`/`previewBrief` are each
 * `useMemo(() => value, [previewKey])`, exactly this shape, so this wrapper
 * is not a stand-in for the bug — it IS the bug's mechanism, feeding a real
 * `PreviewDock` (hence a real `usePreviewFrame`).
 */
function MemoDock({
  rawRailProps,
  brief,
  previewKey,
}: {
  rawRailProps: ReturnType<typeof previewDockProps>;
  brief: CampaignBrief;
  previewKey: string | null;
}) {
  const railProps = useMemo(() => rawRailProps, [previewKey]);
  const previewBrief = useMemo(() => brief, [previewKey]);
  if (railProps === null) return null;
  return <PreviewDock {...railProps} brief={previewBrief} />;
}

describe("the rail's memo must not hide a switch of creative from usePreviewFrame (Qodo, caught in review)", () => {
  /**
   * Two SAVED briefs (`source.kind: "file"`, so `identityKey` is `undefined`
   * for both) whose displayed name and every visual/fetch field are
   * identical — built directly (not through `fromBrief`, which always
   * derives `campaignName` from `id` and so could never produce this
   * precondition) to isolate exactly what `previewRailKey`'s identity term
   * exists for: `rawRailProps` carries the name, never the id, and
   * `previewFetchKey` is a pure content fingerprint with no id in it either.
   */
  const twinState = (loadedId: string): EditorState => {
    let state = initialEditorState("variation");
    state = editorReducer(state, { type: "setProduct", key: 1, patch: { id: "p1", name: "A" } });
    state.campaignName = "twin";
    state.briefId = loadedId;
    state.source = { kind: "file", file: `${loadedId}.yaml`, loadedId, savedSnapshot: null, revision: undefined };
    return state;
  };

  const dock = (state: EditorState) => {
    const rawRailProps = previewDockProps(state, 0, 6);
    const brief = toBrief(state);
    const previewKey = previewRailKey(rawRailProps, brief, state.products[0]?.id ?? "");
    return <MemoDock rawRailProps={rawRailProps} brief={brief} previewKey={previewKey} />;
  };

  test("switching to a saved brief with identical content but a different id clears the stale frame", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());

    const view = render(dock(twinState("twin-a")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS + 10);
    });
    expect(view.container.querySelector("img")).not.toBeNull();

    // Same name, same product colour/logo, same everything previewFetchKey
    // reads — only the id differs. usePreviewFrame's own identity guard
    // promises an immediate, synchronous clear on exactly this switch; a
    // memo upstream that never hands it the new brief defeats that promise
    // without ever touching the guard itself.
    view.rerender(dock(twinState("twin-b")));
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("svg")).not.toBeNull();
  });
});

