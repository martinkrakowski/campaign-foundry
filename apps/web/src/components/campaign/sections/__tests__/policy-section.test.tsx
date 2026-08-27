import { describe, test, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CopyPool } from "@campaignfoundry/CampaignOrchestration";
import { PolicySection } from "../PolicySection";
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

describe("PolicySection — numeric fields", () => {
  test.each([
    ["Count", "count", "12"],
    ["Seed (optional)", "seed", ""],
    ["Min Distance", "minDistance", "2"],
    ["Coverage per Product", "perProduct", "1"],
    ["Coverage per Ratio", "perRatio", "1"],
  ])("%s dispatches setVariation and shows its own error", async (label, field, initial) => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<PolicySection state={state()} dispatch={dispatch} errors={{ [field]: `bad ${field}` }} />);

    const input = screen.getByLabelText(label) as HTMLInputElement;
    expect(input.value).toBe(initial);
    await user.type(input, "3");
    expect(dispatch).toHaveBeenCalledWith({ type: "setVariation", field, value: `${initial}3` });
    expect(screen.getByText(`bad ${field}`)).toBeTruthy();
  });

  test("the min-distance help states the bound the active axes actually allow", () => {
    const { unmount } = render(<PolicySection state={state()} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByText(/Whole numbers, 0–6/)).toBeTruthy();
    unmount();

    // motion widens the bound by two axes, but only while it is a requested format
    render(
      <PolicySection
        state={state({ formats: ["static", "motion"], motion: ["ken-burns-in"] })}
        dispatch={vi.fn()}
        errors={{}}
      />,
    );
    expect(screen.getByText(/Whole numbers, 0–8/)).toBeTruthy();
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
