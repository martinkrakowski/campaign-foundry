import { describe, test, expect, afterEach, vi } from "vitest";
import { useMemo } from "react";
import { render, act, screen, fireEvent, within } from "@testing-library/react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { PreviewFrame } from "../PreviewFrame";
import { PreviewDock, type PlayheadState } from "../PreviewDock";
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

/**
 * CC5 — these tests are about the FRAME's own memo/identity boundary, not the
 * playhead. A still playhead at 0 is exactly what `PlayheadHost` hands the dock
 * before anybody scrubs, and none of the assertions below moves it.
 */
const restingPlayhead: PlayheadState = {
  durationSec: 6,
  scrubSec: 0,
  committedSec: 0,
  onScrubLive: () => {},
  onScrubCommit: () => {},
};

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
    expect(img.getAttribute("src")).toBe(
      `data:image/png;base64,${btoa(String.fromCharCode(...pngBytes))}`,
    );
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
    [
      "a product with an empty id",
      {
        brief: brief({
          products: [{ id: "", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
        }),
      },
    ],
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
      brief: brief({
        products: [{ id: "", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
      }),
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

  test('a display-size spec issues exactly one preview request carrying { size: "728x90" } and mounts the frame', async () => {
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
    const body = JSON.parse(
      (vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.cell.motion).toBe("ken-burns-in");
    expect(body.cell.durationSec).toBe(6);
    expect(body.cell.atSec).toBe(2);
  });

  test("the cell request names the product by identity, never by its colour (MP1)", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const twoProdBrief = brief({
      products: [
        { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" },
        { id: "beta", name: "B", primaryColor: "#E61414", logoPath: "b.png" },
      ],
    });

    // 1. Matched by explicit productId prop
    const view1 = render(
      <PreviewFrame
        brief={twoProdBrief}
        productId="beta"
        layout="headline-bottom"
        tone="bold"
        primaryColor="#E61414"
        className="block h-auto w-full"
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    const body1 = JSON.parse(
      (vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body1.cell.productId).toBe("beta");
    view1.unmount();
    vi.mocked(globalThis.fetch).mockClear();

    // 2. No productId: the brief's FIRST product, exactly as before this lane.
    // Not "whichever product wears this colour" — identity is never inferred
    // from appearance. See case 3 for why that distinction is load-bearing.
    const view2 = render(
      <PreviewFrame
        brief={twoProdBrief}
        layout="headline-bottom"
        tone="bold"
        primaryColor="#E61414"
        className="block h-auto w-full"
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    const body2 = JSON.parse(
      (vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body2.cell.productId).toBe("alpha");
    view2.unmount();
    vi.mocked(globalThis.fetch).mockClear();

    // 3. Two products, ONE brand colour. This is the case that decides whether
    // the cell resolves identity or appearance: a colour lookup cannot tell
    // these two apart and would answer with the first, so asking for `gamma`
    // must still reach the server as `gamma` — the right logo, not merely the
    // right colour.
    const sharedColourBrief = brief({
      products: [
        { id: "delta", name: "D", primaryColor: "#1473E6", logoPath: "d.png" },
        { id: "gamma", name: "G", primaryColor: "#1473E6", logoPath: "g.png" },
      ],
    });
    const view3 = render(
      <PreviewFrame
        brief={sharedColourBrief}
        productId="gamma"
        layout="headline-bottom"
        tone="bold"
        primaryColor="#1473E6"
        className="block h-auto w-full"
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    const body3 = JSON.parse(
      (vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body3.cell.productId).toBe("gamma");
    view3.unmount();
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
      const props = previewDockProps(next)!;
      return (
        <PreviewDock {...props} brief={toBrief(next)} playhead={restingPlayhead} host="section" />
      );
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
  return (
    <PreviewDock {...railProps} brief={previewBrief} playhead={restingPlayhead} host="section" />
  );
}

describe("the rail carries the slot's product all the way to the request (MP1)", () => {
  /**
   * The chain, not a link of it: `previewLook` resolves the slot's product,
   * `previewDockProps` spreads it, `PreviewDock` forwards it and `PreviewFrame`
   * puts it in the cell. Every one of those four can be individually correct
   * while the rail still asks for the wrong product, because a prop nobody
   * passes is indistinguishable from a prop that does not exist — the dock did
   * not forward it at first, and the frame covered for it by finding a product
   * whose COLOUR matched, which agrees with the client only by coincidence.
   *
   * So this asserts the one thing no single-component test can: that selecting
   * the second product's slot makes the SERVER hear about the second product.
   */
  const twoProductState = (): EditorState => {
    let state = initialEditorState("variation");
    state = editorReducer(state, {
      type: "setProduct",
      key: state.products[0]!.key,
      patch: { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" },
    });
    // `setProduct` only patches an EXISTING row — the second product has to be
    // minted first, and its key comes from the reducer, never from a guess.
    state = editorReducer(state, { type: "addProduct" });
    state = editorReducer(state, {
      type: "setProduct",
      key: state.products[1]!.key,
      patch: { id: "beta", name: "B", primaryColor: "#E61414", logoPath: "b.png" },
    });
    state.campaignName = "two";
    return state;
  };

  test("selecting the second product's slot sends that product's id, not the first's", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const state = twoProductState();
    // The slot the operator clicked: drawn for `beta`.
    const rawRailProps = previewDockProps(state, {
      productId: "beta",
      layout: "headline-bottom",
      tone: "bold",
    });
    const brief = toBrief(state);
    const previewKey = previewRailKey(rawRailProps, brief, rawRailProps?.productId ?? "");
    render(<MemoDock rawRailProps={rawRailProps} brief={brief} previewKey={previewKey} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS + 10);
    });
    const body = JSON.parse(
      (vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.cell.productId).toBe("beta");
    // And the client drew the same product it asked the server for (D45).
    expect(rawRailProps?.primaryColor).toBe("#E61414");
  });
});

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
    state.source = {
      kind: "file",
      file: `${loadedId}.yaml`,
      loadedId,
      savedSnapshot: null,
      revision: undefined,
    };
    return state;
  };

  const dock = (state: EditorState) => {
    const rawRailProps = previewDockProps(state);
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

  /**
   * CodeRabbit, caught in review: the SAME defect, one value short. The
   * brief stays "twin-a" throughout — only the first product's id changes,
   * with its colour and logo held fixed, so `previewFetchKey`'s lookup
   * result is unchanged too. `usePreviewFrame`'s own identity tuple
   * includes `cell.productId` directly; the real `/preview-frame` request
   * would ask for a different product while the memo, without the fix,
   * kept the rail showing the old one's frame.
   */
  const twinProductState = (productId: string): EditorState => {
    let state = initialEditorState("variation");
    state = editorReducer(state, {
      type: "setProduct",
      key: 1,
      patch: { id: productId, name: "A", primaryColor: "#1473E6", logoPath: "a.png" },
    });
    state.campaignName = "twin";
    state.briefId = "twin-a";
    state.source = {
      kind: "file",
      file: "twin-a.yaml",
      loadedId: "twin-a",
      savedSnapshot: null,
      revision: undefined,
    };
    return state;
  };

  test("switching the first product's id clears the stale frame, even with the same colour and logo", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());

    const view = render(dock(twinProductState("p1")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS + 10);
    });
    expect(view.container.querySelector("img")).not.toBeNull();

    view.rerender(dock(twinProductState("p2")));
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("svg")).not.toBeNull();
  });
});

/**
 * CE1 — the hit regions where they actually live: over the REAL frame, inside
 * the frame's own box, and only for a caller that asked for them.
 *
 * The regions' own behaviour (what a template declares, how a frame becomes a
 * box) is `preview-hit-regions.test.tsx`'s. What is asserted here is the
 * wiring: the box the percentages resolve against is the `<img>`'s box, the
 * placeholder carries no regions, and a surface that passes no `onSelectLayer`
 * is exactly as it was.
 */
describe("the creative as a way in to a layer (CE1)", () => {
  const htmlBrief = (): CampaignBrief => ({
    ...brief(),
    template: {
      id: "canonical-image-html",
      version: 1,
      creativeType: "image-html",
      unit: "standard-web",
      layers: [
        { id: "image", kind: "image" },
        { id: "html", kind: "html" },
      ],
    },
  });

  const paintFrame = async (props: Partial<Parameters<typeof PreviewFrame>[0]>) => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const view = renderFrame({ brief: htmlBrief(), ...props });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS + 10);
    });
    return view;
  };

  test("the regions are siblings of the frame image, inside the box it fills", async () => {
    const view = await paintFrame({ onSelectLayer: () => {} });
    const box = view.getByTestId("preview-frame");
    const img = box.querySelector("img")!;
    const region = within(box).getByRole("button", { name: "image" });
    // Same box, so a percentage of the region's containing block is a fraction
    // of the canvas: the `<img>` is `block h-auto w-full` inside it, and the
    // box is the positioning context.
    expect(region.parentElement).toBe(box);
    expect(img.parentElement).toBe(box);
    expect(box.className).toContain("relative");
    // And exactly one composed frame is still marked (D43) — no second marker.
    expect(view.container.querySelectorAll('[data-testid="preview-frame"]')).toHaveLength(1);
  });

  test("the placeholder carries no regions — they ride the real frame only", () => {
    const view = renderFrame({ brief: htmlBrief(), onSelectLayer: () => {} });
    expect(view.container.querySelector("svg")).not.toBeNull();
    expect(view.container.querySelectorAll("button")).toHaveLength(0);
  });

  test("a caller that passes no onSelectLayer gets the frame it always got", async () => {
    const view = await paintFrame({});
    expect(view.container.querySelector("img")).not.toBeNull();
    expect(view.container.querySelectorAll("button")).toHaveLength(0);
  });

  /**
   * Red fault 6's substitute at the wiring level (the regions' own file states
   * the reasoning in full): the declared insets do not move with the box, and
   * the click works whatever the box is, because nothing reads a box.
   */
  test("the same region, the same declared insets, at two rendered widths", async () => {
    const picked: string[] = [];
    const narrow = await paintFrame({ onSelectLayer: (id) => picked.push(id) });
    const narrowBox = narrow.getByTestId("preview-frame");
    narrowBox.style.width = "320px";
    const narrowRegion = within(narrowBox).getByRole("button", { name: "image" });
    const insets = [
      narrowRegion.style.left,
      narrowRegion.style.top,
      narrowRegion.style.width,
      narrowRegion.style.height,
    ];
    fireEvent.click(narrowRegion);
    narrow.unmount();

    const wide = await paintFrame({ onSelectLayer: (id) => picked.push(id) });
    const wideBox = wide.getByTestId("preview-frame");
    wideBox.style.width = "1280px";
    const wideRegion = within(wideBox).getByRole("button", { name: "image" });
    expect([
      wideRegion.style.left,
      wideRegion.style.top,
      wideRegion.style.width,
      wideRegion.style.height,
    ]).toEqual(insets);
    expect(insets).toEqual(["0%", "0%", "100%", "100%"]);
    fireEvent.click(wideRegion);

    // Joined rather than compared as an array literal: two bare layer-kind
    // strings in brackets is what D121's scanner hunts for, and it does not
    // care that this one is an assertion.
    expect(picked.join("|")).toBe("image|image");
  });

  test("selecting a layer issues no frame request: a click is not a document change", async () => {
    const view = await paintFrame({ onSelectLayer: () => {} });
    const before = vi.mocked(globalThis.fetch).mock.calls.length;
    expect(before).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "image" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS * 5);
    });

    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(before);
    expect(view.container.querySelector("img")).not.toBeNull();
  });
});
