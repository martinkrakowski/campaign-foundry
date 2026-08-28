import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SwatchChip, hueShiftHex } from "../swatch-chip";

describe("hueShiftHex", () => {
  test("a shift of zero is the colour itself, whichever channel leads", () => {
    for (const hex of ["#ff0000", "#00ff00", "#0000ff", "#1473e6"]) {
      expect(hueShiftHex(hex, 0)).toBe(hex);
    }
  });

  test("a third of the wheel walks red → green → blue → red", () => {
    expect(hueShiftHex("#ff0000", 1 / 3)).toBe("#00ff00");
    expect(hueShiftHex("#00ff00", 1 / 3)).toBe("#0000ff");
    expect(hueShiftHex("#0000ff", 1 / 3)).toBe("#ff0000");
  });

  test("a red past magenta wraps the wheel rather than going negative", () => {
    // max === r with g < b takes the +6 wrap; without it the hue would be negative
    expect(hueShiftHex("#ff0080", 0)).toBe("#ff0080");
    expect(hueShiftHex("#ff0080", 1 / 3)).toBe("#80ff00");
  });

  test("a grey has no hue to shift, so it comes back unchanged", () => {
    // delta === 0: saturation stays 0 and every channel resolves to the lightness
    expect(hueShiftHex("#808080", 0.25)).toBe("#808080");
    expect(hueShiftHex("#ffffff", 0.5)).toBe("#ffffff");
    expect(hueShiftHex("#000000", 0.5)).toBe("#000000");
  });

  test("light and dark colours both convert back (the two saturation branches)", () => {
    // lightness > 0.5 takes one denominator, <= 0.5 the other
    expect(hueShiftHex("#ffcccc", 0)).toBe("#ffcccc");
    expect(hueShiftHex("#330000", 0)).toBe("#330000");
  });

  test("anything that is not a six-digit hex is returned untouched", () => {
    for (const value of ["", "red", "#abc", "#12345g", "1473e6", "#1473e66"]) {
      expect(hueShiftHex(value, 0.5)).toBe(value);
    }
  });
});

describe("SwatchChip", () => {
  test("is named by the raw value, and fills itself with the colour that value makes", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<SwatchChip value={0.1} selected={false} baseColor="#ff0000" onToggle={onToggle} />);

    const chip = screen.getByRole("button", { name: "0.1" });
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    const swatch = chip.querySelector("span[style]") as HTMLElement;
    expect(swatch.style.backgroundColor).not.toBe("");
    expect(swatch.getAttribute("aria-hidden")).toBe("true");
    await user.click(chip);
    expect(onToggle).toHaveBeenCalledWith(0.1);
  });

  test("selected is marked pressed", () => {
    render(<SwatchChip value={0} selected baseColor="#1473e6" onToggle={vi.fn()} />);
    expect(screen.getByRole("button", { name: "0" }).getAttribute("aria-pressed")).toBe("true");
  });
});
