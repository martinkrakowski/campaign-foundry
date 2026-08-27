import { describe, test, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CopyPool } from "@campaignfoundry/CampaignOrchestration";
import { PolicySection } from "../PolicySection";
import { axisProductSize, maxMinDistance } from "../../validate";
import {
  initialEditorState,
  editorReducer,
  LAYOUT_OPTIONS,
  TONE_OPTIONS,
  BACKGROUND_OPTIONS,
  PALETTE_SHIFT_OPTIONS,
  HEADLINE_POOL_REF,
  type EditorState,
} from "../../editor-state";

const pool = (statuses: string[]): CopyPool =>
  ({ entries: statuses.map((status, i) => ({ id: `e${i}`, text: `t${i}`, status })) }) as unknown as CopyPool;

const state = (over: Partial<EditorState> = {}): EditorState => ({
  ...initialEditorState(),
  mode: "variation",
  briefId: "camp",
  ...over,
});

/** The fieldset for a given legend, so a toggle is addressed unambiguously. */
const axis = (legend: string) => screen.getByText(legend).closest("fieldset") as HTMLElement;

describe("PolicySection", () => {
  test("renders nothing for a classic brief", () => {
    const { container } = render(
      <PolicySection state={state({ mode: "brief" })} dispatch={vi.fn()} errors={{}} />,
    );
    expect(container.innerHTML).toBe("");
  });
});

describe("PolicySection — the policy numbers", () => {
  test("Count is a slider bounded by what the axes can actually produce", async () => {
    const dispatch = vi.fn();
    // 2 products × 3 ratios × 2 layouts × 2 tones × 1 background × 3 palette shifts
    const s = state({ variation: { ...state().variation, paletteShift: [0, 0.1, 0.2] } });
    render(<PolicySection state={s} dispatch={dispatch} errors={{}} />);

    const slider = screen.getByLabelText("Count") as HTMLInputElement;
    expect(slider.type).toBe("range");
    expect(slider.min).toBe("1");
    expect(slider.max).toBe(String(axisProductSize(s)));
    expect(slider.value).toBe("12");

    fireEvent.change(slider, { target: { value: "20" } });
    expect(dispatch).toHaveBeenCalledWith({ type: "setVariation", field: "count", value: "20" });
  });

  test("the count readout shows the value against the ceiling, and flags its error", () => {
    render(<PolicySection state={state()} dispatch={vi.fn()} errors={{ count: "bad count" }} />);
    expect(screen.getByText("bad count")).toBeTruthy();
    expect(screen.getByText(/12/).textContent).toMatch(/12\s*\/\s*\d+/);
  });

  test("Min distance steps within the active axes and can be left to the planner", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    const s = state();
    render(<PolicySection state={s} dispatch={dispatch} errors={{}} />);

    const readout = screen.getByRole("spinbutton", { name: "Min distance" });
    expect(readout.getAttribute("aria-valuemax")).toBe(String(maxMinDistance(s)));
    expect(readout.textContent).toBe("2");

    await user.click(screen.getByRole("button", { name: "Increase Min distance" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "setVariation", field: "minDistance", value: "3" });
    await user.click(screen.getByRole("button", { name: "Decrease Min distance" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "setVariation", field: "minDistance", value: "1" });
  });

  test("an unset min distance reads as the planner's default, and stepping up sets it", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    const s = state();
    render(
      <PolicySection state={{ ...s, variation: { ...s.variation, minDistance: "" } }} dispatch={dispatch} errors={{}} />,
    );
    expect(screen.getByRole("spinbutton", { name: "Min distance" }).textContent).toBe("Auto (1)");
    await user.click(screen.getByRole("button", { name: "Increase Min distance" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "setVariation", field: "minDistance", value: "0" });
  });

  test.each([
    ["Coverage per product", "perProduct"],
    ["Coverage per ratio", "perRatio"],
  ])("%s is an optional floor, shown as such when unset", async (label, field) => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    const s = state();
    const { unmount } = render(
      <PolicySection state={{ ...s, variation: { ...s.variation, [field]: "" } }} dispatch={dispatch} errors={{}} />,
    );
    expect(screen.getByRole("spinbutton", { name: label }).textContent).toBe("No floor");
    unmount();

    render(<PolicySection state={s} dispatch={dispatch} errors={{ [field]: `bad ${field}` }} />);
    expect(screen.getByText(`bad ${field}`)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: `Increase ${label}` }));
    expect(dispatch).toHaveBeenCalledWith({ type: "setVariation", field, value: "2" });
  });

  test("Seed can be typed, picked, or cleared back to automatic", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    const s = state();
    const { unmount } = render(<PolicySection state={s} dispatch={dispatch} errors={{ seed: "bad seed" }} />);
    await user.type(screen.getByPlaceholderText("Auto"), "7");
    expect(dispatch).toHaveBeenCalledWith({ type: "setVariation", field: "seed", value: "7" });
    expect(screen.getByText("bad seed")).toBeTruthy();

    // empty seed → offer to pick one
    await user.click(screen.getByRole("button", { name: "Pick a seed" }));
    const picked = dispatch.mock.calls.map((c) => c[0]).find((a) => a.field === "seed" && a.value !== "7");
    expect(Number(picked.value)).toBeGreaterThanOrEqual(0);
    unmount();

    // a set seed → offer to clear it
    dispatch.mockClear();
    render(
      <PolicySection state={{ ...s, variation: { ...s.variation, seed: "42" } }} dispatch={dispatch} errors={{}} />,
    );
    await user.click(screen.getByRole("button", { name: "Clear the seed" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "setVariation", field: "seed", value: "" });
  });

  test("the min-distance help states the bound the active axes actually allow", () => {
    const { unmount } = render(<PolicySection state={state()} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByText(/up to 6, the active axes/)).toBeTruthy();
    unmount();

    render(
      <PolicySection
        state={state({ formats: ["static", "motion"], motion: ["ken-burns-in"] })}
        dispatch={vi.fn()}
        errors={{}}
      />,
    );
    expect(screen.getByText(/up to 8, the active axes/)).toBeTruthy();
  });
});

describe("PolicySection — axes", () => {
  test("layout, tone and background toggle through their own actions", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<PolicySection state={state()} dispatch={dispatch} errors={{}} />);

    await user.click(within(axis("Layout")).getByText(LAYOUT_OPTIONS[0]));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleLayout", value: LAYOUT_OPTIONS[0] });

    await user.click(within(axis("Tone")).getByText(TONE_OPTIONS[1]));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleTone", value: TONE_OPTIONS[1] });

    await user.click(within(axis("Background Source")).getByText(BACKGROUND_OPTIONS[2]));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleBackground", value: BACKGROUND_OPTIONS[2] });
  });

  test("a selected axis value is marked pressed, an unselected one is not", () => {
    render(<PolicySection state={state()} dispatch={vi.fn()} errors={{}} />);
    // background defaults to procedural only
    const bg = within(axis("Background Source"));
    expect(bg.getByText("procedural").getAttribute("aria-pressed")).toBe("true");
    expect(bg.getByText("genai").getAttribute("aria-pressed")).toBe("false");
  });

  test("palette shift toggles numerically", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<PolicySection state={state()} dispatch={dispatch} errors={{}} />);
    await user.click(within(axis("Palette Shift")).getByText(String(PALETTE_SHIFT_OPTIONS[1])));
    expect(dispatch).toHaveBeenCalledWith({ type: "togglePalette", value: PALETTE_SHIFT_OPTIONS[1] });
  });

  test("each axis renders its own error", () => {
    render(
      <PolicySection
        state={state()}
        dispatch={vi.fn()}
        errors={{ layout: "pick a layout", tone: "pick a tone", background: "pick a source", paletteShift: "pick a shift" }}
      />,
    );
    expect(screen.getByText("pick a layout")).toBeTruthy();
    expect(screen.getByText("pick a tone")).toBeTruthy();
    expect(screen.getByText("pick a source")).toBeTruthy();
    expect(screen.getByText("pick a shift")).toBeTruthy();
  });

  test("the heading carries a badge counting the section's errors", () => {
    render(<PolicySection state={state()} dispatch={vi.fn()} errors={{ count: "a", seed: "b" }} />);
    expect(screen.getByRole("heading", { name: /Variation Policy/ }).textContent).toContain("2");
  });
});

describe("PolicySection — the headline axis and its pool", () => {
  const headlineToggle = () => within(axis("Headline")).getByText(HEADLINE_POOL_REF);

  test("an unloaded pool is reported as unloaded, not as empty", () => {
    render(<PolicySection state={state({ pool: null })} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByText(/Headline pool not loaded/)).toBeTruthy();
    expect(screen.queryByText(/no approved entries/)).toBeNull();
    // and it must not be disabled on the strength of a pool nobody fetched
    expect((headlineToggle() as HTMLButtonElement).disabled).toBe(false);
  });

  test("a loaded pool with nothing approved blocks the axis and says why", () => {
    render(<PolicySection state={state({ pool: pool(["pending", "rejected"]) })} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByText(/no approved entries/)).toBeTruthy();
    expect((headlineToggle() as HTMLButtonElement).disabled).toBe(true);
  });

  test("a loaded pool with approved entries reports the count and allows the toggle", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(
      <PolicySection state={state({ pool: pool(["approved", "approved", "pending"]) })} dispatch={dispatch} errors={{}} />,
    );
    expect(screen.getByText("2 approved headlines")).toBeTruthy();
    await user.click(headlineToggle());
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleHeadline" });
  });

  test("one approved entry is described in the singular", () => {
    render(<PolicySection state={state({ pool: pool(["approved"]) })} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByText("1 approved headline")).toBeTruthy();
  });

  test("an axis already on can always be switched off, even against an empty pool", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    // loadPool no longer clears the axis for the user, so the toggle is the only way out
    const stuck = editorReducer(state({ pool: pool(["pending"]) }), { type: "toggleHeadline" });
    render(<PolicySection state={stuck} dispatch={dispatch} errors={{}} />);

    const toggle = headlineToggle() as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.disabled).toBe(false);
    await user.click(toggle);
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleHeadline" });
  });

  test("an axis that is off stays blocked while the pool has nothing approved", () => {
    render(<PolicySection state={state({ pool: pool(["pending"]) })} dispatch={vi.fn()} errors={{}} />);
    expect((headlineToggle() as HTMLButtonElement).disabled).toBe(true);
  });

  test("the toggle reflects whether the axis is on", () => {
    const on = editorReducer(state({ pool: pool(["approved"]) }), { type: "toggleHeadline" });
    const { unmount } = render(<PolicySection state={on} dispatch={vi.fn()} errors={{}} />);
    expect(headlineToggle().getAttribute("aria-pressed")).toBe("true");
    unmount();

    render(<PolicySection state={state({ pool: pool(["approved"]) })} dispatch={vi.fn()} errors={{}} />);
    expect(headlineToggle().getAttribute("aria-pressed")).toBe("false");
  });
});
