import { describe, test, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

    const customBtn = screen.getByRole("button", { name: "Custom colour" });
    expect(customBtn.getAttribute("aria-pressed")).toBe("false");

    rerender(<SwatchPicker value="#ABCDEF" onChange={vi.fn()} />);
    for (const swatch of SWATCH_PALETTE) {
      expect(screen.getByRole("button", { name: swatch }).getAttribute("aria-pressed")).toBe("false");
    }
    expect(customBtn.getAttribute("aria-pressed")).toBe("true");
  });

  test("custom swatch triggers visually-hidden color input and fires onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SwatchPicker value="#1473E6" onChange={onChange} />);

    const customButton = screen.getByRole("button", { name: "Custom colour" });
    const colorInput = screen.getByLabelText("Custom colour picker") as HTMLInputElement;

    expect(colorInput).toBeTruthy();
    expect(colorInput.className).toContain("sr-only");
    expect(colorInput.type).toBe("color");

    const clickSpy = vi.spyOn(colorInput, "click");
    await user.click(customButton);
    expect(clickSpy).toHaveBeenCalled();

    // Trigger color input change
    fireEvent.change(colorInput, { target: { value: "#336699" } });
    expect(onChange).toHaveBeenCalledWith("#336699");
  });

  test("supports size='lg' (52px) and ring-style selection with custom colour and label", () => {
    const { rerender } = render(
      <SwatchPicker value="#1473E6" onChange={vi.fn()} size="lg" />,
    );

    const first = screen.getByRole("button", { name: "#1473E6" });
    expect(first.className).toContain("size-[52px]");
    expect(first.className).toContain("ring-brand-primary");

    const customBtn = screen.getByRole("button", { name: "Custom colour" });
    expect(customBtn.className).toContain("size-[52px]");
    expect(customBtn.getAttribute("aria-pressed")).toBe("false");

    // Rerender with custom colour selected and size='lg' with label
    rerender(
      <SwatchPicker value="#ABCDEF" onChange={vi.fn()} size="lg" label="Product" />,
    );
    const customWithLabel = screen.getByRole("button", { name: "Product custom colour" });
    expect(customWithLabel.getAttribute("aria-pressed")).toBe("true");
    expect(customWithLabel.className).toContain("ring-brand-primary");

    const colorPicker = screen.getByLabelText("Product custom colour picker") as HTMLInputElement;
    expect(colorPicker.value).toBe("#abcdef");

    // Custom colour with size='default'
    rerender(<SwatchPicker value="#ABCDEF" onChange={vi.fn()} size="default" />);
    const customDefault = screen.getByRole("button", { name: "Custom colour" });
    expect(customDefault.className).toContain("size-6");

    // Invalid non-hex string falls back safely to default in color input
    rerender(<SwatchPicker value="not-a-hex" onChange={vi.fn()} size="default" />);
    const fallbackPicker = screen.getByLabelText("Custom colour picker") as HTMLInputElement;
    expect(fallbackPicker.value).toBe("#1473e6");

    rerender(<SwatchPicker value="#1473E6" onChange={vi.fn()} size="default" />);
    expect(first.className).toContain("size-6");
  });

  test("disabled and readOnly prevent changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<SwatchPicker value="#1473E6" onChange={onChange} disabled />);

    const button = screen.getByRole("button", { name: "#E0218A" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    await user.click(button);
    expect(onChange).not.toHaveBeenCalled();

    const customButton = screen.getByRole("button", { name: "Custom colour" }) as HTMLButtonElement;
    expect(customButton.disabled).toBe(true);

    const input = screen.getByLabelText("Hex colour") as HTMLInputElement;
    expect(input.disabled).toBe(true);

    rerender(<SwatchPicker value="#1473E6" onChange={onChange} readOnly />);
    const inputReadOnly = screen.getByLabelText("Hex colour") as HTMLInputElement;
    expect(inputReadOnly.readOnly).toBe(true);
  });
});

