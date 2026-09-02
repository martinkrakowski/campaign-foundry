import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { initialEditorState, type EditorState } from "@/components/campaign/editor-state";
import { LayoutSection } from "../LayoutSection";
import { PREVIEW_FRAME_DEBOUNCE_MS } from "@/lib/preview-frame";
import * as messages from "../../messages";

const pngBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
const pngResponse = () =>
  new Response(pngBytes, {
    status: 200,
    headers: { "content-type": "image/png", "x-preview-frame-cache-key": "k".repeat(64) },
  });

const state = (over: Partial<EditorState> = {}): EditorState => ({
  ...initialEditorState(),
  briefId: "camp",
  campaignMessage: "Hi",
  products: [{ ...initialEditorState().products[0], id: "alpha", name: "A" }],
  ...over,
});

/** A randomized draft: the axes give the look, so the frame's look is fully specified. */
const variationState = (over: Partial<EditorState> = {}): EditorState =>
  state({ mode: "variation", ...over });

afterEach(() => {
  vi.useRealTimers();
});

describe("LayoutSection — the type controls (T5/T7)", () => {
  test("each style control dispatches setStyle with the domain's value", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<LayoutSection state={state()} dispatch={dispatch} errors={{}} />);

    await user.click(screen.getByRole("button", { name: "Lora" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "setStyle", patch: { fontFamily: "Lora" } });
    await user.click(screen.getByRole("button", { name: "Bold" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "setStyle", patch: { fontWeight: 700 } });
    await user.click(screen.getByRole("button", { name: "Left" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "setStyle", patch: { align: "left" } });

    fireEvent.change(screen.getByRole("slider", { name: "Size" }), { target: { value: "0.08" } });
    expect(dispatch).toHaveBeenCalledWith({ type: "setStyle", patch: { sizeScale: 0.08 } });
    fireEvent.change(screen.getByRole("slider", { name: "Line height" }), { target: { value: "1.4" } });
    expect(dispatch).toHaveBeenCalledWith({ type: "setStyle", patch: { lineHeight: 1.4 } });
    fireEvent.change(screen.getByRole("slider", { name: "Letter spacing" }), { target: { value: "0.05" } });
    expect(dispatch).toHaveBeenCalledWith({ type: "setStyle", patch: { letterSpacing: 0.05 } });
  });

  test("the controls show the leaf's defaults for an absent field, never a blank", () => {
    render(<LayoutSection state={state()} dispatch={vi.fn()} errors={{}} />);
    // An untouched style is `{}`: the chips wear the defaults the compositor resolves.
    expect(screen.getByRole("button", { name: "Inter" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Regular" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Center" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("the size readout shows the derived pixels at the previewed ratio, never the stored fraction (D55)", () => {
    const { unmount } = render(
      <LayoutSection state={state({ style: { sizeScale: 0.08 } })} dispatch={vi.fn()} errors={{}} />,
    );
    // 0.08 of the square canvas' 1080 px width, rounded — derived text.
    expect(screen.getByText(messages.styleSizeReadout(86, "Square"))).toBeTruthy();
    expect(screen.queryByText(/0\.08/)).toBeNull();
    unmount();
    // The readout follows the previewed ratio: a wide canvas is 1920 px across.
    render(
      <LayoutSection
        state={variationState({ platforms: ["x"], style: { sizeScale: 0.08 } })}
        dispatch={vi.fn()}
        errors={{}}
      />,
    );
    expect(screen.getByText(messages.styleSizeReadout(154, "Wide"))).toBeTruthy();
  });
});

describe("LayoutSection — the hosted surfaces", () => {
  test("the type controls render in both modes — the treatments panel keeps its own step", () => {
    const { unmount } = render(<LayoutSection state={state()} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByRole("button", { name: "Inter" })).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 2, name: /Treatments/ })).toBeNull();
    unmount();
    render(<LayoutSection state={variationState()} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByRole("button", { name: "Inter" })).toBeTruthy();
  });

  test("without the preview flag there is no frame and no request — the Everything stack shows controls only", () => {
    const calls = vi.mocked(globalThis.fetch).mock.calls.length;
    const { container } = render(<LayoutSection state={variationState()} dispatch={vi.fn()} errors={{}} />);
    expect(container.querySelector("figure")).toBeNull();
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(calls);
  });

  test("a non-procedural background names the frame's background a stand-in (D52)", () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("route down"));
    const genai = variationState({
      variation: { ...initialEditorState().variation, background: ["genai"] },
    });
    render(<LayoutSection state={genai} dispatch={vi.fn()} errors={{}} preview />);
    expect(screen.getByText(/background is a stand-in until the run/)).toBeTruthy();
  });
});

describe("LayoutSection — the frame follows the controls (T1b/D63)", () => {
  test("the frame refetches when a style control changes — debounced, never per keystroke", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const view = render(<LayoutSection state={variationState()} dispatch={vi.fn()} errors={{}} preview />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(1);

    // Two edits inside the debounce window settle into ONE request for the latest look.
    view.rerender(
      <LayoutSection state={variationState({ style: { sizeScale: 0.08 } })} dispatch={vi.fn()} errors={{}} preview />,
    );
    view.rerender(
      <LayoutSection
        state={variationState({ style: { sizeScale: 0.08, lineHeight: 1.4 } })}
        dispatch={vi.fn()}
        errors={{}}
        preview
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBe(2);
    // The request carries the brief exactly as the projection wrote it — the
    // style edit is IN the frame's brief (the round-trip the preview shows).
    const body = JSON.parse(
      (vi.mocked(globalThis.fetch).mock.calls[1][1] as RequestInit).body as string,
    ) as { brief: { style?: { lineHeight?: number } } };
    expect(body.brief.style?.lineHeight).toBe(1.4);
  });

  test("with the preview flag the real frame arrives: an img where the placeholder stood", async () => {
    vi.useFakeTimers();
    vi.mocked(globalThis.fetch).mockResolvedValue(pngResponse());
    const { container } = render(
      <LayoutSection state={variationState()} dispatch={vi.fn()} errors={{}} preview />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_FRAME_DEBOUNCE_MS);
    });
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });
});
