import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModePanel } from "../mode-panel";

describe("ModePanel", () => {
  test("each mode card captions itself with its display name (D4)", () => {
    render(<ModePanel mode="brief" onSetMode={() => {}} />);
    // The cards keep the raw value as the accessible name; the words under it
    // come from display-names, one map for every mode surface. Bound per card:
    // a swapped caption must fail here, not hide in a tree-wide getByText.
    expect(screen.getByRole("button", { name: "brief" }).textContent).toContain("Classic");
    expect(screen.getByRole("button", { name: "variation" }).textContent).toContain("Randomized");
  });

  test("the pressed card is the editor's current mode, and pressing dispatches setMode", async () => {
    const onSetMode = vi.fn();
    const user = userEvent.setup();
    render(<ModePanel mode="variation" onSetMode={onSetMode} />);
    expect(screen.getByRole("button", { name: "variation" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "brief" }).getAttribute("aria-pressed")).toBe("false");
    await user.click(screen.getByRole("button", { name: "brief" }));
    expect(onSetMode).toHaveBeenCalledWith("brief");
  });
});
