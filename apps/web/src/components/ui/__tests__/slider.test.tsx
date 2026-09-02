import { describe, test, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Slider } from "../slider";

const setup = (over: Partial<Parameters<typeof Slider>[0]> = {}) => {
  const onChange = vi.fn();
  const view = render(<Slider aria-label="Count" value={4} min={1} max={10} onChange={onChange} {...over} />);
  return { onChange, view, input: view.container.querySelector("input") as HTMLInputElement };
};

describe("Slider", () => {
  test("is a bounded range that reports the number it moved to", () => {
    const { onChange, input } = setup();
    expect(input.type).toBe("range");
    expect([input.min, input.max, input.value]).toEqual(["1", "10", "4"]);
    fireEvent.change(input, { target: { value: "7" } });
    expect(onChange).toHaveBeenCalledWith(7);
  });

  test("a fractional step serves fractional bounds without re-scaling the value", () => {
    const { onChange, input, view } = setup({ min: 0.02, max: 0.12, step: 0.005, value: 0.06 });
    expect(input.step).toBe("0.005");
    fireEvent.change(input, { target: { value: "0.08" } });
    expect(onChange).toHaveBeenCalledWith(0.08);
    view.unmount();
    // Default stays the bounded integer the slider always was.
    expect(setup().input.step).toBe("1");
  });

  test("shows the value against the ceiling, with a suffix when given", () => {
    const { unmount } = render(<Slider aria-label="Count" value={4} min={1} max={10} onChange={vi.fn()} />);
    expect(screen.getByText(/4/).textContent).toContain("/ 10");
    unmount();
    render(<Slider aria-label="Length" value={6} min={2} max={30} onChange={vi.fn()} suffix="s" />);
    expect(screen.getByText(/6s/)).toBeTruthy();
  });

  test("clamps a value outside the range rather than rendering an invalid position", () => {
    const above = setup({ value: 99 });
    expect(above.input.value).toBe("10");
    above.view.unmount();
    expect(setup({ value: -5 }).input.value).toBe("1");
  });

  test("survives a max below the min without inverting the range", () => {
    const { input } = setup({ min: 1, max: 0, value: 1 });
    expect(input.max).toBe("1");
  });

  test("marks itself invalid and can be disabled", () => {
    const { input } = setup({ invalid: true, disabled: true });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.disabled).toBe(true);
  });
});
