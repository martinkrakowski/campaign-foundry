import { describe, test, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OptionTile } from "../option-tile";

function allSlots(onToggle = vi.fn()) {
  return (
    <OptionTile
      value="brief"
      name="Classic"
      tag="Guided"
      blurb="One design, repeated."
      meta="6 creatives"
      description="needs a source"
      selected={false}
      onToggle={onToggle}
    >
      <svg data-testid="picture" />
    </OptionTile>
  );
}

describe("OptionTile", () => {
  test("the accessible name is exactly the raw value, with every optional slot filled", () => {
    render(allSlots());
    // Every slot is on screen; the name is still just the value — the whole-name
    // role query is the regression that would cost every getByRole("button",
    // { name }) caller in the suite if any slot leaked into the name.
    const button = screen.getByRole("button", { name: "brief" });
    expect(button.getAttribute("aria-label")).toBe("brief");
    expect(button.textContent).toContain("Classic");
    expect(button.textContent).toContain("Guided");
    expect(button.textContent).toContain("One design, repeated.");
    expect(button.textContent).toContain("6 creatives");
    expect(screen.getByTestId("picture")).toBeTruthy();
  });

  test("the tag, the blurb and the meta line are aria-hidden, so none of them extends the name", () => {
    render(allSlots());
    for (const slot of [screen.getByText("Guided"), screen.getByText("One design, repeated."), screen.getByText("6 creatives")]) {
      expect(slot.getAttribute("aria-hidden")).toBe("true");
    }
    // the exact-name query again: anything un-hidden would have broken it above
    expect(screen.getByRole("button", { name: "brief" })).toBeTruthy();
  });

  test("the description is reached through aria-describedby and never through the name", () => {
    render(allSlots());
    const button = screen.getByRole("button", { name: "brief" });
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe("needs a source");
    expect(screen.getByText("needs a source").getAttribute("aria-hidden")).toBeNull();
  });

  test("without a description nothing points anywhere", () => {
    render(
      <OptionTile value="variation" name="Randomized" selected={false} onToggle={vi.fn()}>
        <span />
      </OptionTile>,
    );
    expect(screen.getByRole("button", { name: "variation" }).getAttribute("aria-describedby")).toBeNull();
  });

  test("aria-pressed follows selected", () => {
    const { rerender } = render(
      <OptionTile value="brief" name="Classic" selected={false} onToggle={vi.fn()}>
        <span />
      </OptionTile>,
    );
    expect(screen.getByRole("button", { name: "brief" }).getAttribute("aria-pressed")).toBe("false");
    rerender(
      <OptionTile value="brief" name="Classic" selected onToggle={vi.fn()}>
        <span />
      </OptionTile>,
    );
    expect(screen.getByRole("button", { name: "brief" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("a selected tile carries the selected treatment and the one-shot check badge; an unselected one the control edge", () => {
    const { rerender } = render(
      <OptionTile value="brief" name="Classic" selected={false} onToggle={vi.fn()}>
        <span />
      </OptionTile>,
    );
    const unselected = screen.getByRole("button", { name: "brief" });
    expect(unselected.className).toContain("border-border-control");
    expect(unselected.className).toContain("hover:border-border-control-hover");
    expect(unselected.className).not.toContain("border-brand-primary");
    expect(
      Array.from(unselected.querySelectorAll("span")).some((span) => span.className.includes("animate-check-pop")),
    ).toBe(false);

    rerender(
      <OptionTile value="brief" name="Classic" selected onToggle={vi.fn()}>
        <span />
      </OptionTile>,
    );
    const selected = screen.getByRole("button", { name: "brief" });
    expect(selected.className).toContain("border-brand-primary");
    expect(selected.className).toContain("bg-brand-primary/[0.08]");
    const badge = Array.from(selected.querySelectorAll("span")).find((span) =>
      span.className.includes("animate-check-pop"),
    );
    expect(badge).toBeTruthy();
    expect(badge?.getAttribute("aria-hidden")).toBe("true");
  });

  test("the unselected picture sits back and returns to full on selection — a transition, never a loop (D88)", () => {
    const { rerender } = render(
      <OptionTile value="brief" name="Classic" selected={false} onToggle={vi.fn()}>
        <span data-testid="picture" />
      </OptionTile>,
    );
    const unselectedButton = screen.getByRole("button", { name: "brief" });
    const pictureHolder = screen.getByTestId("picture").parentElement as HTMLElement;
    expect(pictureHolder.getAttribute("aria-hidden")).toBe("true");
    expect(pictureHolder.className).toContain("opacity-[0.55]");
    expect(pictureHolder.className).toContain("saturate-[0.45]");
    expect(pictureHolder.className).toContain("transition-[opacity,filter]");
    // dimmed is not animated: nothing loops, by utility class or otherwise —
    // the tile's own className as well as the picture wrapper (D88)
    expect(unselectedButton.className).not.toMatch(/animate-/);
    expect(pictureHolder.className).not.toMatch(/animate-/);

    rerender(
      <OptionTile value="brief" name="Classic" selected onToggle={vi.fn()}>
        <span data-testid="picture" />
      </OptionTile>,
    );
    const selectedButton = screen.getByRole("button", { name: "brief" });
    const full = screen.getByTestId("picture").parentElement as HTMLElement;
    expect(selectedButton.className).not.toMatch(/animate-/);
    expect(full.className).toContain("opacity-100");
    expect(full.className).toContain("saturate-100");
  });

  test("blurb is the neutral tone and description is the warning tone", () => {
    render(allSlots());
    const blurb = screen.getByText("One design, repeated.");
    const description = screen.getByText("needs a source");
    expect(blurb.className).toContain("text-text-secondary");
    expect(blurb.className).not.toContain("text-warning");
    expect(description.className).toContain("text-warning");
    expect(description.className).not.toContain("text-text-secondary");
  });

  test("pressing toggles with the raw value, by mouse or keyboard", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <OptionTile value="variation" name="Randomized" selected={false} onToggle={onToggle}>
        <span />
      </OptionTile>,
    );
    await user.click(screen.getByRole("button", { name: "variation" }));
    expect(onToggle).toHaveBeenCalledWith("variation");
    screen.getByRole("button", { name: "variation" }).focus();
    await user.keyboard("{Enter}");
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  test("a disabled tile refuses the press", () => {
    const onToggle = vi.fn();
    render(
      <OptionTile value="motion" name="Motion" selected={false} onToggle={onToggle} disabled>
        <span />
      </OptionTile>,
    );
    const button = screen.getByRole("button", { name: "motion" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // userEvent refuses a disabled control, so the press is simulated directly
    fireEvent.click(button);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
