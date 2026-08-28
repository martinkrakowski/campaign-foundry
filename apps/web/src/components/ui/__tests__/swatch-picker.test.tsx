import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SwatchPicker, SWATCH_PALETTE } from "../swatch-picker";

describe("SwatchPicker", () => {
  test("renders all 8 canonical swatches with their hex values as accessible names", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SwatchPicker value="#1473E6" onChange={onChange} />);

    for (const swatch of SWATCH_PALETTE) {
      expect(screen.getByRole("button", { name: swatch })).toBeTruthy();
    }

    const first = screen.getByRole("button", { name: "#1473E6" });
    expect(first.getAttribute("aria-pressed")).toBe("true");

    const second = screen.getByRole("button", { name: "#E0218A" });
    expect(second.getAttribute("aria-pressed")).toBe("false");

    await user.click(second);
    expect(onChange).toHaveBeenCalledWith("#E0218A");
  });

  test("hex text input reflects current value and fires onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SwatchPicker value="#1473E6" onChange={onChange} />);

    const input = screen.getByLabelText("Hex colour") as HTMLInputElement;
    expect(input.value).toBe("#1473E6");

    await user.clear(input);
    await user.type(input, "#FF00FF");
    expect(onChange).toHaveBeenCalled();
  });

  test("custom hex input is supported and matches case-insensitively", () => {
    const { rerender } = render(<SwatchPicker value="#e0218a" onChange={vi.fn()} />);
    const match = screen.getByRole("button", { name: "#E0218A" });
    expect(match.getAttribute("aria-pressed")).toBe("true");

    rerender(<SwatchPicker value="#ABCDEF" onChange={vi.fn()} />);
    for (const swatch of SWATCH_PALETTE) {
      expect(screen.getByRole("button", { name: swatch }).getAttribute("aria-pressed")).toBe("false");
    }
  });

  test("disabled and readOnly prevent changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<SwatchPicker value="#1473E6" onChange={onChange} disabled />);

    const button = screen.getByRole("button", { name: "#E0218A" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(onChange).not.toHaveBeenCalled();

    const input = screen.getByLabelText("Hex colour") as HTMLInputElement;
    expect(input.disabled).toBe(true);

    rerender(<SwatchPicker value="#1473E6" onChange={onChange} readOnly />);
    const inputReadOnly = screen.getByLabelText("Hex colour") as HTMLInputElement;
    expect(inputReadOnly.readOnly).toBe(true);
  });
});
