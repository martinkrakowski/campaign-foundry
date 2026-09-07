import { describe, test, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IdentitySection } from "../IdentitySection";
import { editorReducer, initialEditorState, type EditorAction, type EditorState } from "../../editor-state";
import * as messages from "../../messages";

const state = (over: Partial<EditorState> = {}): EditorState => ({
  ...initialEditorState(),
  briefId: "camp",
  ...over,
});

/**
 * The section is controlled: a dispatch must reach the reducer and rerender, or
 * the second half of a two-direction claim (map → chip, chip → map) cannot be
 * observed at all.
 */
const renderWithReducer = (initial: EditorState) => {
  let current = initial;
  const dispatch = vi.fn((action: EditorAction) => {
    current = editorReducer(current, action);
    rerender(<IdentitySection state={current} dispatch={dispatch} errors={{}} />);
  });
  const { rerender, container } = render(
    <IdentitySection state={current} dispatch={dispatch} errors={{}} />,
  );
  return { dispatch, container, getState: () => current };
};

/**
 * F4/D94 — the map and the region chips are two views of one value, wired exactly
 * as M2 wired them in the dialog. The chips stay the accessible and keyboard
 * control: the map's SVG is aria-hidden and adds no focusable element.
 */
describe("IdentitySection — the world map", () => {
  test("clicking a footprint sets the region exactly as its chip does — the two are one control", () => {
    const { dispatch, container } = renderWithReducer(state());

    fireEvent.click(container.querySelector('[data-region="EU"]') as SVGGElement);
    expect(dispatch).toHaveBeenCalledWith({ type: "patch", patch: { targetRegion: "EU" } });
    expect(screen.getByRole("button", { name: "EU" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("clicking a chip paints its footprint — the map reads the same value", async () => {
    const user = userEvent.setup();
    renderWithReducer(state());

    await user.click(screen.getByRole("button", { name: "DE" }));

    const selected = document.querySelectorAll("[data-selected]");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("data-region")).toBe("DE");
  });

  test("Other… paints no footprint, and a typed custom region keeps the map clear", async () => {
    const user = userEvent.setup();
    const { dispatch } = renderWithReducer(state());

    await user.click(screen.getByRole("button", { name: messages.targetRegionOther }));
    expect(document.querySelectorAll("[data-selected]")).toHaveLength(0);

    const other = screen.getByLabelText(messages.targetRegionOtherInputLabel);
    await user.type(other, "LATAM");
    expect(dispatch).toHaveBeenLastCalledWith({ type: "patch", patch: { targetRegion: "LATAM" } });
    expect(document.querySelectorAll("[data-selected]")).toHaveLength(0);
  });

  // M2's Other-then-map path: ChipGroup closes customOpen when `value` becomes a
  // known option (chip-group.tsx:59-64). The dialog pins this at
  // CreateCampaignDialog.test.tsx:1003; Identity's Other test above only
  // asserts that Other… paints no footprint.
  test("a map pick after Other… selects that chip and closes the custom input", async () => {
    const user = userEvent.setup();
    const { container, getState } = renderWithReducer(state());

    await user.click(screen.getByRole("button", { name: messages.targetRegionOther }));
    const other = screen.getByLabelText(messages.targetRegionOtherInputLabel);
    await user.type(other, "LATAM");

    fireEvent.click(container.querySelector('[data-region="DE"]') as SVGGElement);

    expect(getState().targetRegion).toBe("DE");
    expect(screen.getByRole("button", { name: "DE" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: messages.targetRegionOther }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.queryByLabelText(messages.targetRegionOtherInputLabel)).toBeNull();
  });

  test("compact omits the map — the chips alone remain, and still work", async () => {
    const user = userEvent.setup();
    const dispatch = vi.fn();
    const { container } = render(
      <IdentitySection state={state()} dispatch={dispatch} errors={{}} compact />,
    );

    expect(container.querySelector("svg")).toBeNull();
    expect(screen.queryByText(messages.worldMapRegionHint)).toBeNull();

    // The keyboard path survives the compact form (D94): the chips still dispatch.
    await user.click(screen.getByRole("button", { name: "DE" }));
    expect(dispatch).toHaveBeenCalledWith({ type: "patch", patch: { targetRegion: "DE" } });
  });

  test("the map is aria-hidden chrome: it adds no focusable element to the section", async () => {
    const user = userEvent.setup();
    const { container } = render(<IdentitySection state={state()} dispatch={vi.fn()} errors={{}} />);

    await user.click(screen.getByRole("button", { name: "EU" }));

    const svg = (container.querySelector('[data-region="EU"]') as SVGGElement).closest(
      "svg",
    ) as SVGSVGElement;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.querySelectorAll("[tabindex], button, a")).toHaveLength(0);
  });

  test("the hint is written against F2, and the section adds no live region of its own", () => {
    const { container } = render(<IdentitySection state={state()} dispatch={vi.fn()} errors={{}} />);

    const hint = screen.getByText(messages.worldMapRegionHint);
    expect(hint.textContent).not.toMatch(/dispatch|per region|\brun/i);
    expect(container.querySelector("p.sr-only")?.textContent).toBe(messages.worldMapFallbackHint);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });
});
