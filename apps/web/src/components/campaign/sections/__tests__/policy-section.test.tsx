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

/**
 * Render with Advanced open. Most of what this panel offers lives behind that door
 * (D6), and the Disclosure remembers its state in localStorage — so open it only when
 * it is actually closed, or a second test in the same file would close it again.
 */
const renderOpen = (ui: Parameters<typeof render>[0]) => {
  const result = render(ui);
  const advanced = screen.getByRole("button", { name: "Advanced" });
  if (advanced.getAttribute("aria-expanded") !== "true") fireEvent.click(advanced);
  return result;
};

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
    renderOpen(<PolicySection state={s} dispatch={dispatch} errors={{}} />);

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
    // anchored to the bare value: the ratio panels carry their own "N of count" texts
    expect(screen.getByText(/^12$/).textContent).toMatch(/12\s*\/\s*\d+/);
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
    renderOpen(
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
    const { unmount } = renderOpen(
      <PolicySection state={{ ...s, variation: { ...s.variation, [field]: "" } }} dispatch={dispatch} errors={{}} />,
    );
    expect(screen.getByRole("spinbutton", { name: label }).textContent).toBe("No floor");
    unmount();

    renderOpen(<PolicySection state={s} dispatch={dispatch} errors={{ [field]: `bad ${field}` }} />);
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
    renderOpen(<PolicySection state={state()} dispatch={dispatch} errors={{}} />);

    await user.click(within(axis("Layout")).getByText(LAYOUT_OPTIONS[0]));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleLayout", value: LAYOUT_OPTIONS[0] });

    await user.click(within(axis("Tone")).getByText(TONE_OPTIONS[1]));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleTone", value: TONE_OPTIONS[1] });

    await user.click(within(axis("Background Source")).getByText(BACKGROUND_OPTIONS[2]));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleBackground", value: BACKGROUND_OPTIONS[2] });
  });

  test("layout and tone cards answer to their raw value as the whole accessible name", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<PolicySection state={state()} dispatch={dispatch} errors={{}} />);

    // the same query 61 assertions across the suite make: role + whole name.
    // The glyph and any caption inside the card must never extend that name.
    const top = within(axis("Layout")).getByRole("button", { name: "headline-top" }) as HTMLButtonElement;
    expect(top.getAttribute("aria-pressed")).toBe("true");
    await user.click(top);
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleLayout", value: "headline-top" });

    await user.click(within(axis("Tone")).getByRole("button", { name: "subtle" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleTone", value: "subtle" });

    // the preview is decoration carried by the card
    expect(top.querySelector("svg[aria-hidden='true']")).toBeTruthy();
  });

  test("every advanced axis shows what it does, and is still named by its raw value", () => {
    renderOpen(<PolicySection state={state()} dispatch={vi.fn()} errors={{}} />);
    // D18: the picture is decoration; the accessible name stays the value the brief
    // stores, so a screen reader and the YAML agree.
    const bg = within(axis("Background Source")).getByRole("button", { name: "procedural" });
    expect(bg.querySelector("svg")).toBeTruthy();
    expect(bg.textContent).toContain("A pattern we draw");
    const swatch = within(axis("Palette Shift")).getByRole("button", { name: "0.1" });
    expect(swatch.querySelector("span[style]")?.getAttribute("style")).toContain("background-color");
    expect(screen.getByRole("switch", { name: HEADLINE_POOL_REF })).toBeTruthy();
  });

  test("the card grid holds two columns in the 320px sidebar and auto-fills when wide", () => {
    const { unmount } = render(<PolicySection state={state()} dispatch={vi.fn()} errors={{}} />);
    const wideGrid = axis("Layout").querySelector("div") as HTMLElement;
    expect(wideGrid.className).toContain("auto-fill");
    unmount();

    render(<PolicySection state={state()} dispatch={vi.fn()} errors={{}} compact />);
    const compactGrid = axis("Layout").querySelector("div") as HTMLElement;
    expect(compactGrid.className).toContain("grid-cols-2");
  });

  test("a selected axis value is marked pressed, an unselected one is not", () => {
    renderOpen(<PolicySection state={state()} dispatch={vi.fn()} errors={{}} />);
    // background defaults to procedural only
    const bg = within(axis("Background Source"));
    expect(bg.getByRole("button", { name: "procedural" }).getAttribute("aria-pressed")).toBe("true");
    expect(bg.getByRole("button", { name: "genai" }).getAttribute("aria-pressed")).toBe("false");
  });

  test("a brief with no products still draws its swatches, from the kit's own blue", () => {
    renderOpen(<PolicySection state={state({ products: [] })} dispatch={vi.fn()} errors={{}} />);
    const swatch = within(axis("Palette Shift"))
      .getByRole("button", { name: "0" })
      .querySelector("span[style]") as HTMLElement;
    expect(swatch.style.backgroundColor).not.toBe("");
  });

  test("palette shift toggles numerically", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    renderOpen(<PolicySection state={state()} dispatch={dispatch} errors={{}} />);
    await user.click(within(axis("Palette Shift")).getByRole("button", { name: String(PALETTE_SHIFT_OPTIONS[1]) }));
    expect(dispatch).toHaveBeenCalledWith({ type: "togglePalette", value: PALETTE_SHIFT_OPTIONS[1] });
  });

  test("each axis renders its own error", () => {
    renderOpen(
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

describe("PolicySection — aspect ratio panels", () => {
  const ratioFieldset = () => axis("Aspect ratios");

  test("each panel answers to its raw ratio as the whole accessible name", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<PolicySection state={state()} dispatch={dispatch} errors={{}} />);

    const square = within(ratioFieldset()).getByRole("button", { name: "1:1" }) as HTMLButtonElement;
    expect(square.getAttribute("aria-pressed")).toBe("true");
    await user.click(square);
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleRatio", value: "1:1" });

    // the frame and the floor are decoration carried by the card — they must never
    // extend the name (the invariant every getByRole query leans on)
    expect(square.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(within(square).getByText("≥ 1 each").getAttribute("aria-hidden")).toBe("true");
  });

  test("each panel shows its pixel spec, and never invents a per-ratio allocation", () => {
    render(<PolicySection state={state()} dispatch={vi.fn()} errors={{}} />);
    const fieldset = ratioFieldset();
    expect(within(fieldset).getByText("1080 × 1080")).toBeTruthy();
    expect(within(fieldset).getByText("1080 × 1920")).toBeTruthy();
    expect(within(fieldset).getByText("1920 × 1080")).toBeTruthy();
    // The planner round-robins only the deficient coverage axes and then fills to
    // `count` from a seeded random draw, so above the floor no ratio has a
    // predictable share. A panel must not claim one.
    expect(within(fieldset).queryByText(/\d+ of \d+/)).toBeNull();
  });

  test("the floor is one setting: the same ≥ N each on every panel, and 'no floor' when unset", () => {
    const { unmount } = render(<PolicySection state={state()} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getAllByText("≥ 1 each")).toHaveLength(3);
    unmount();

    render(
      <PolicySection
        state={{ ...state(), variation: { ...state().variation, perRatio: "" } }}
        dispatch={vi.fn()}
        errors={{}}
      />,
    );
    expect(screen.getAllByText("no floor")).toHaveLength(3);
  });

  test("the constraint readout binds the floor to the selection and turns red when it cannot fit", () => {
    const { unmount } = render(<PolicySection state={state()} dispatch={vi.fn()} errors={{}} />);
    const ok = screen.getByText("floor 1 × 3 selected = 3 of count 12");
    expect(ok.className).toContain("text-text-muted");
    unmount();

    render(
      <PolicySection
        state={{ ...state(), variation: { ...state().variation, perRatio: "2", count: "5" } }}
        dispatch={vi.fn()}
        errors={{ perRatio: "coverage.perRatio 2 × 3 selected ratios exceeds count 5" }}
      />,
    );
    const over = screen.getByText(/floor 2 × 3 selected = 6 of count 5/);
    expect(over.className).toContain("text-error");
    expect(over.textContent).toMatch(/lower the floor, raise the count, or select fewer ratios/);
  });

  test("an excluded panel is muted with its reason, and the reason names the motion-capable ratios", () => {
    render(
      <PolicySection
        state={state({
          formats: ["motion"],
          platforms: ["instagram-reel"],
          motion: ["ken-burns-in"],
          duration: [4],
        })}
        dispatch={vi.fn()}
        errors={{}}
      />,
    );
    // instagram-reel packages motion at 9:16 only: the other two canvases are excluded
    const reasons = screen.getAllByText(/Excluded — motion-only output can draw \[9:16\] only/);
    expect(reasons).toHaveLength(2);

    // The reason must reach assistive technology. It is referenced by
    // aria-describedby rather than nested as content, because content would join
    // the accessible name and break every getByRole({ name }) query in the suite.
    const square = within(ratioFieldset()).getByRole("button", { name: "1:1" });
    const describedBy = square.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const description = document.getElementById(describedBy as string);
    expect(description?.textContent).toMatch(/Excluded — motion-only output can draw \[9:16\] only/);
    expect(description?.getAttribute("aria-hidden")).toBeNull();
  });

  test("an excluded ratio the brief already selects stays clickable — deselecting is the way out", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(
      <PolicySection
        state={state({
          formats: ["motion"],
          platforms: ["instagram-reel"],
          motion: ["ken-burns-in"],
          duration: [4],
          variation: { ...state().variation, ratio: ["1:1"] },
        })}
        dispatch={dispatch}
        errors={{}}
      />,
    );
    const square = within(ratioFieldset()).getByRole("button", { name: "1:1" }) as HTMLButtonElement;
    expect(square.getAttribute("aria-pressed")).toBe("true");
    expect(square.disabled).toBe(false);
    await user.click(square);
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleRatio", value: "1:1" });
  });

  test("an excluded ratio that is not selected cannot be switched on", () => {
    render(
      <PolicySection
        state={state({
          formats: ["motion"],
          platforms: ["instagram-reel"],
          motion: ["ken-burns-in"],
          duration: [4],
          variation: { ...state().variation, ratio: ["9:16"] },
        })}
        dispatch={vi.fn()}
        errors={{}}
      />,
    );
    const square = within(ratioFieldset()).getByRole("button", { name: "1:1" }) as HTMLButtonElement;
    expect(square.disabled).toBe(true);
    expect(screen.getAllByText(/Excluded — motion-only output can draw \[9:16\] only/)).toHaveLength(2);
  });

  test("the exclusion reason says so plainly when no selected platform packages motion at any ratio", () => {
    render(
      <PolicySection
        state={state({ formats: ["motion"], platforms: ["instagram-feed"], motion: ["ken-burns-in"] })}
        dispatch={vi.fn()}
        errors={{}}
      />,
    );
    expect(screen.getAllByText(/Excluded — no selected platform packages motion at any ratio/)).toHaveLength(3);
  });

  test("the coverage-per-ratio stepper sits inside the ratio fieldset, beside its effect", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    render(<PolicySection state={state()} dispatch={dispatch} errors={{}} />);
    const fieldset = ratioFieldset();
    expect(within(fieldset).getByRole("spinbutton", { name: "Coverage per ratio" })).toBeTruthy();
    expect(within(fieldset).getByRole("button", { name: "Increase Coverage per ratio" })).toBeTruthy();
    await user.click(within(fieldset).getByRole("button", { name: "Increase Coverage per ratio" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "setVariation", field: "perRatio", value: "2" });
  });

  test("the panel grid holds two columns in the 320px sidebar and auto-fills when wide", () => {
    const { unmount } = render(<PolicySection state={state()} dispatch={vi.fn()} errors={{}} />);
    const wideGrid = ratioFieldset().querySelector("div.grid") as HTMLElement;
    expect(wideGrid.className).toContain("auto-fill");
    unmount();

    render(<PolicySection state={state()} dispatch={vi.fn()} errors={{}} compact />);
    const compactGrid = ratioFieldset().querySelector("div.grid") as HTMLElement;
    expect(compactGrid.className).toContain("grid-cols-2");
  });

  test("a selection with no ratio left renders the section's own error", () => {
    renderOpen(
      <PolicySection
        state={{ ...state(), variation: { ...state().variation, ratio: [] } }}
        dispatch={vi.fn()}
        errors={{ ratio: "Select at least one aspect ratio." }}
      />,
    );
    expect(screen.getByText("Select at least one aspect ratio.")).toBeTruthy();
  });
});

describe("PolicySection — the headline axis and its pool", () => {
  // the axis is a switch row now: a real role="switch" whose name is the pool ref, so
  // the state is read from aria-checked rather than aria-pressed
  const headlineToggle = () =>
    screen.getByRole("switch", { name: HEADLINE_POOL_REF }) as HTMLButtonElement;

  test("an unloaded pool is reported as unloaded, not as empty", () => {
    renderOpen(<PolicySection state={state({ pool: null })} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByText(/Headline pool not loaded/)).toBeTruthy();
    expect(screen.queryByText(/no approved entries/)).toBeNull();
    // and it must not be disabled on the strength of a pool nobody fetched
    expect(headlineToggle().disabled).toBe(false);
  });

  test("a loaded pool with nothing approved blocks the axis and says why", () => {
    renderOpen(<PolicySection state={state({ pool: pool(["pending", "rejected"]) })} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByText(/no approved entries/)).toBeTruthy();
    expect(headlineToggle().disabled).toBe(true);
  });

  test("a loaded pool with approved entries reports the count and allows the toggle", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    renderOpen(
      <PolicySection state={state({ pool: pool(["approved", "approved", "pending"]) })} dispatch={dispatch} errors={{}} />,
    );
    expect(screen.getByText("2 approved headlines")).toBeTruthy();
    await user.click(headlineToggle());
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleHeadline" });
  });

  test("one approved entry is described in the singular", () => {
    renderOpen(<PolicySection state={state({ pool: pool(["approved"]) })} dispatch={vi.fn()} errors={{}} />);
    expect(screen.getByText("1 approved headline")).toBeTruthy();
  });

  test("an axis already on can always be switched off, even against an empty pool", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    // loadPool no longer clears the axis for the user, so the toggle is the only way out
    const stuck = editorReducer(state({ pool: pool(["pending"]) }), { type: "toggleHeadline" });
    renderOpen(<PolicySection state={stuck} dispatch={dispatch} errors={{}} />);

    const toggle = headlineToggle();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.disabled).toBe(false);
    await user.click(toggle);
    expect(dispatch).toHaveBeenCalledWith({ type: "toggleHeadline" });
  });

  test("an axis that is off stays blocked while the pool has nothing approved", () => {
    renderOpen(<PolicySection state={state({ pool: pool(["pending"]) })} dispatch={vi.fn()} errors={{}} />);
    expect(headlineToggle().disabled).toBe(true);
  });

  test("the toggle reflects whether the axis is on", () => {
    const on = editorReducer(state({ pool: pool(["approved"]) }), { type: "toggleHeadline" });
    const { unmount } = renderOpen(<PolicySection state={on} dispatch={vi.fn()} errors={{}} />);
    expect(headlineToggle().getAttribute("aria-checked")).toBe("true");
    unmount();

    renderOpen(<PolicySection state={state({ pool: pool(["approved"]) })} dispatch={vi.fn()} errors={{}} />);
    expect(headlineToggle().getAttribute("aria-checked")).toBe("false");
  });
});
