import { describe, test, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AxisCard } from "../axis-card";
import { CreativeGlyph } from "../creative-glyph";

describe("AxisCard", () => {
  test("renders an unselected card whose accessible name is exactly the raw value", () => {
    render(
      <AxisCard value="headline-top" selected={false} onToggle={vi.fn()}>
        <CreativeGlyph layout="headline-top" />
      </AxisCard>,
    );
    const button = screen.getByRole("button", { name: "headline-top" }) as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe("headline-top");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.className).toContain("border-border");
    expect(button.textContent).toContain("headline-top");
  });

  test("a selected card is marked pressed and carries the selected treatment and a check", () => {
    render(
      <AxisCard value="bold" selected onToggle={vi.fn()}>
        <CreativeGlyph tone="bold" />
      </AxisCard>,
    );
    const button = screen.getByRole("button", { name: "bold" }) as HTMLButtonElement;
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.className).toContain("border-brand-primary");
    expect(button.className).toContain("bg-surface-2");
    expect(button.querySelector("svg[aria-hidden='true']")).toBeTruthy();
  });

  test("the glyph preview is rendered but hidden from the name computation", () => {
    render(
      <AxisCard value="subtle" selected={false} onToggle={vi.fn()}>
        <CreativeGlyph tone="subtle" />
      </AxisCard>,
    );
    const button = screen.getByRole("button", { name: "subtle" });
    const holder = button.querySelector("svg")?.parentElement as HTMLElement;
    expect(holder.getAttribute("aria-hidden")).toBe("true");
  });

  test("meta is visible but aria-hidden — the name stays exactly the value", () => {
    render(
      <AxisCard value="headline-top" selected={false} onToggle={vi.fn()} meta="shade .7">
        <CreativeGlyph layout="headline-top" />
      </AxisCard>,
    );
    // the whole-name role query is the regression that would cost every
    // getByRole("button", { name }) in the suite: meta must not extend the name
    const button = screen.getByRole("button", { name: "headline-top" }) as HTMLButtonElement;
    const meta = screen.getByText("shade .7");
    expect(meta.getAttribute("aria-hidden")).toBe("true");
    expect(button.contains(meta)).toBe(true);
  });

  test("clicking (mouse or keyboard) toggles with the raw value", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(
      <AxisCard value="headline-bottom" selected={false} onToggle={onToggle}>
        <CreativeGlyph layout="headline-bottom" />
      </AxisCard>,
    );
    await user.click(screen.getByRole("button", { name: "headline-bottom" }));
    expect(onToggle).toHaveBeenCalledWith("headline-bottom");

    onToggle.mockClear();
    rerender(
      <AxisCard value="headline-bottom" selected onToggle={onToggle}>
        <CreativeGlyph layout="headline-bottom" />
      </AxisCard>,
    );
    // a real <button>: Enter works for free
    screen.getByRole("button", { name: "headline-bottom" }).focus();
    await user.keyboard("{Enter}");
    expect(onToggle).toHaveBeenCalledWith("headline-bottom");
  });

  test("a disabled card does not fire and is visibly disabled", () => {
    const onToggle = vi.fn();
    const { container } = render(
      <AxisCard value="genai" selected={false} onToggle={onToggle} disabled>
        <span>x</span>
      </AxisCard>,
    );
    const button = screen.getByRole("button", { name: "genai" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.className).toContain("disabled:opacity-50");
    fireEvent.click(button);
    expect(onToggle).not.toHaveBeenCalled();
    expect(container.querySelector("svg")).toBeNull();
  });
});
