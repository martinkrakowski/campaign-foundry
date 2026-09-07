import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RegionChip } from "../region-chip";

describe("RegionChip", () => {
  test("the accessible name is exactly the label — dot and mono code never join it", () => {
    render(<RegionChip label="Global" code="GLOBAL" pressed={false} onToggle={() => {}} />);
    const chip = screen.getByRole("button", { name: "Global" });
    expect(chip.textContent).toContain("Global");
    expect(chip.textContent).toContain("GLOBAL");
    expect(chip.getAttribute("aria-label")).toBe("Global");
  });

  test.each([true, false])("aria-pressed follows the pressed prop (%s)", (pressed) => {
    render(<RegionChip label="Europe" code="EU" pressed={pressed} onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: "Europe" }).getAttribute("aria-pressed")).toBe(
      String(pressed),
    );
  });

  test("the state dot is aria-hidden and fills the brand token only when pressed", () => {
    const { container, rerender } = render(
      <RegionChip label="Europe" code="EU" pressed={true} onToggle={() => {}} />,
    );
    const dot = container.querySelector("span[aria-hidden='true']") as HTMLSpanElement;
    expect(dot.getAttribute("class")).toContain("bg-brand-primary");
    rerender(<RegionChip label="Europe" code="EU" pressed={false} onToggle={() => {}} />);
    expect(dot.getAttribute("class")).not.toContain("bg-brand-primary");
  });

  test("the unselected edge is the control boundary token", () => {
    render(<RegionChip label="Europe" code="EU" pressed={false} onToggle={() => {}} />);
    const chip = screen.getByRole("button", { name: "Europe" });
    expect(chip.getAttribute("class")).toContain("border-border-control");
  });

  test("clicking toggles", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<RegionChip label="Europe" code="EU" pressed={false} onToggle={onToggle} />);
    await user.click(screen.getByRole("button", { name: "Europe" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test("disabled blocks the toggle", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<RegionChip label="Europe" code="EU" pressed={false} onToggle={onToggle} disabled />);
    const chip = screen.getByRole("button", { name: "Europe" }) as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    await user.click(chip);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
