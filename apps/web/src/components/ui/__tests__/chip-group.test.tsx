import { describe, test, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChipGroup } from "../chip-group";

const OPTIONS = ["GLOBAL", "EU", "DE", "UK", "US", "APAC"] as const;

describe("ChipGroup", () => {
  test("renders options with their raw values as accessible names (D18 contract)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ChipGroup options={OPTIONS} value="DE" onChange={onChange} />);

    for (const option of OPTIONS) {
      expect(screen.getByRole("button", { name: option })).toBeTruthy();
    }

    const deButton = screen.getByRole("button", { name: "DE" });
    expect(deButton.getAttribute("aria-pressed")).toBe("true");

    const euButton = screen.getByRole("button", { name: "EU" });
    expect(euButton.getAttribute("aria-pressed")).toBe("false");

    await user.click(euButton);
    expect(onChange).toHaveBeenCalledWith("EU");
  });

  test("does not render Other button when allowOther is false or otherLabel is omitted", () => {
    const { unmount } = render(<ChipGroup options={OPTIONS} value="DE" onChange={vi.fn()} allowOther={false} otherLabel="Other…" />);
    expect(screen.queryByRole("button", { name: "Other…" })).toBeNull();
    unmount();

    render(<ChipGroup options={OPTIONS} value="DE" onChange={vi.fn()} allowOther={true} />);
    expect(screen.queryByRole("button", { name: "Other…" })).toBeNull();
  });

  test("clicking Other reveals free text input and fires onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ChipGroup
        options={OPTIONS}
        value="DE"
        onChange={onChange}
        allowOther
        otherLabel="Other…"
        otherPlaceholder="e.g. LATAM"
      />,
    );

    const otherButton = screen.getByRole("button", { name: "Other…" });
    expect(otherButton.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByPlaceholderText("e.g. LATAM")).toBeNull();

    await user.click(otherButton);
    expect(onChange).toHaveBeenCalledWith("");
    expect(otherButton.getAttribute("aria-pressed")).toBe("true");

    const input = screen.getByPlaceholderText("e.g. LATAM");
    expect(input).toBeTruthy();

    await user.type(input, "LATAM");
    expect(onChange).toHaveBeenLastCalledWith("M");
  });

  test("clicking Other when value is already empty or custom does not clear custom value", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ChipGroup
        options={OPTIONS}
        value="LATAM"
        onChange={onChange}
        allowOther
        otherLabel="Other…"
        otherPlaceholder="e.g. LATAM"
      />,
    );

    const otherButton = screen.getByRole("button", { name: "Other…" });
    fireEvent.click(otherButton);
    expect(onChange).not.toHaveBeenCalled();

    rerender(
      <ChipGroup
        options={OPTIONS}
        value=""
        onChange={onChange}
        allowOther
        otherLabel="Other…"
        otherPlaceholder="e.g. LATAM"
      />,
    );
    fireEvent.click(otherButton);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("automatically reveals custom input when value is not in options", () => {
    render(
      <ChipGroup
        options={OPTIONS}
        value="FR"
        onChange={vi.fn()}
        allowOther
        otherLabel="Other…"
        otherPlaceholder="e.g. LATAM"
      />,
    );
    const otherButton = screen.getByRole("button", { name: "Other…" });
    expect(otherButton.getAttribute("aria-pressed")).toBe("true");

    const input = screen.getByPlaceholderText("e.g. LATAM") as HTMLInputElement;
    expect(input.value).toBe("FR");
  });

  test("clicking an option chip while custom input is open resets custom state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <ChipGroup
        options={OPTIONS}
        value="FR"
        onChange={onChange}
        allowOther
        otherLabel="Other…"
        otherPlaceholder="e.g. LATAM"
      />,
    );

    expect(screen.getByPlaceholderText("e.g. LATAM")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "UK" }));
    expect(onChange).toHaveBeenCalledWith("UK");

    rerender(
      <ChipGroup
        options={OPTIONS}
        value="UK"
        onChange={onChange}
        allowOther
        otherLabel="Other…"
        otherPlaceholder="e.g. LATAM"
      />,
    );
    expect(screen.queryByPlaceholderText("e.g. LATAM")).toBeNull();
    expect(screen.getByRole("button", { name: "UK" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("sr-only input reflects value and fires onChange", () => {
    const onChange = vi.fn();
    render(<ChipGroup label="Target Region" options={OPTIONS} value="EU" onChange={onChange} />);

    const input = screen.getByLabelText("Target Region") as HTMLInputElement;
    expect(input.value).toBe("EU");

    fireEvent.change(input, { target: { value: "US" } });
    expect(onChange).toHaveBeenCalledWith("US");
  });

  test("disabled and readOnly disable the buttons", () => {
    const { rerender } = render(
      <ChipGroup
        options={OPTIONS}
        value="DE"
        onChange={vi.fn()}
        allowOther
        otherLabel="Other…"
        disabled={true}
      />,
    );

    const deButton = screen.getByRole("button", { name: "DE" }) as HTMLButtonElement;
    expect(deButton.disabled).toBe(true);

    const otherButton = screen.getByRole("button", { name: "Other…" }) as HTMLButtonElement;
    expect(otherButton.disabled).toBe(true);

    rerender(
      <ChipGroup
        options={OPTIONS}
        value="DE"
        onChange={vi.fn()}
        allowOther
        otherLabel="Other…"
        readOnly={true}
      />,
    );
    const euButton = screen.getByRole("button", { name: "EU" }) as HTMLButtonElement;
    expect(euButton.disabled).toBe(true);
  });
});
