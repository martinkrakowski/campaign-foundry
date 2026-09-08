import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SwatchChip, hueShiftHex } from "../swatch-chip";
import { normalizeHueTurns } from "@campaignfoundry/CampaignOrchestration/palette-shift";

describe("hueShiftHex wraps exactly as the renderer does", () => {
  // The defect this replaced: the swatch computed `(hue + shift) % 1` while the procedural
  // background generator computed `((hue + shift) % 1 + 1) % 1`. For hue 0.05 and shift
  // -0.1 that is -0.05 against 0.95 — the chip previewed a colour the pipeline would never
  // render. Both now call the domain's `normalizeHueTurns`.
  test("a negative shift previews the colour its wrapped equivalent does", () => {
    for (const hex of ["#ff0000", "#1473e6", "#00ff00", "#0000ff"]) {
      for (const shift of [-0.1, -0.25, -0.5, -1.75]) {
        expect(hueShiftHex(hex, shift)).toBe(hueShiftHex(hex, normalizeHueTurns(shift)));
      }
    }
  });

  test("a shift of a whole turn or more previews as its wrapped equivalent", () => {
    for (const hex of ["#ff0000", "#1473e6"]) {
      expect(hueShiftHex(hex, 1)).toBe(hueShiftHex(hex, 0));
      expect(hueShiftHex(hex, 1.25)).toBe(hueShiftHex(hex, 0.25));
      expect(hueShiftHex(hex, 3)).toBe(hueShiftHex(hex, 0));
    }
  });

  test("no shift, however written, ever produces a negative hue channel", () => {
    // A negative hue used to fall through the piecewise conversion and emit a colour with
    // no relationship to the requested rotation. Every channel must stay a byte.
    for (const shift of [-0.001, -0.3, -2.4, 0.7, 5.5]) {
      const out = hueShiftHex("#1473e6", shift);
      expect(out).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

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
