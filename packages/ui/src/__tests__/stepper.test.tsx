import { describe, test, expect, vi } from "vitest";
import { render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Stepper } from "../stepper";

const setup = (over: Partial<Parameters<typeof Stepper>[0]> = {}) => {
  const onChange = vi.fn();
  const view = render(<Stepper aria-label="Distance" value="2" min={0} max={5} onChange={onChange} {...over} />);
  const q = within(view.container);
  return {
    onChange,
    view,
    user: userEvent.setup(),
    readout: q.getByRole("spinbutton", { name: "Distance" }),
    up: q.getByRole("button", { name: "Increase Distance" }) as HTMLButtonElement,
    down: q.getByRole("button", { name: "Decrease Distance" }) as HTMLButtonElement,
  };
};

describe("Stepper", () => {
  test("steps within its bounds and reports the new value as the editor stores it", async () => {
    const { user, onChange, up, down, readout } = setup();
    expect(readout.textContent).toBe("2");
    expect(readout.getAttribute("aria-valuenow")).toBe("2");
    await user.click(up);
    expect(onChange).toHaveBeenCalledWith("3");
    await user.click(down);
    expect(onChange).toHaveBeenCalledWith("1");
  });

  test("states its bounds by disabling its own buttons", () => {
    const top = setup({ value: "5" });
    expect(top.up.disabled).toBe(true);
    top.view.unmount();
    expect(setup({ value: "0" }).down.disabled).toBe(true);
  });

  test("clamps a value already past the ceiling instead of stepping beyond it", async () => {
    const { user, onChange, up } = setup({ value: "9" });
    expect(up.disabled).toBe(true);
    await user.click(up);
    expect(onChange).not.toHaveBeenCalled();
  });

  test("an unset value reads as its label, steps up to the minimum, and back down to unset", async () => {
    const { user, onChange, readout, up, down } = setup({ value: "", allowUnset: true, unsetLabel: "Auto (1)" });
    expect(readout.textContent).toBe("Auto (1)");
    expect(readout.getAttribute("aria-valuenow")).toBeNull();
    expect(readout.getAttribute("aria-valuetext")).toBe("Auto (1)");
    expect(down.disabled).toBe(true); // already unset: there is nowhere lower

    await user.click(up);
    expect(onChange).toHaveBeenCalledWith("0");
  });

  test("stepping below the minimum returns to unset when that is allowed, and holds otherwise", async () => {
    const unsettable = setup({ value: "0", allowUnset: true });
    expect(unsettable.down.disabled).toBe(false);
    await unsettable.user.click(unsettable.down);
    expect(unsettable.onChange).toHaveBeenCalledWith("");
    unsettable.view.unmount();

    expect(setup({ value: "0" }).down.disabled).toBe(true);
  });

  test("stepping up from a value below the floor lands on the floor, not below it", async () => {
    const { user, onChange, up } = setup({ value: "-4", min: 0, max: 5 });
    await user.click(up);
    expect(onChange).toHaveBeenCalledWith("0");
  });

  test("a non-numeric value falls back to the minimum rather than rendering NaN", async () => {
    const { user, onChange, up } = setup({ value: "not a number" });
    await user.click(up);
    expect(onChange).toHaveBeenCalledWith("1");
  });

  test("marks itself invalid and can be disabled", () => {
    const { up, down } = setup({ invalid: true, disabled: true });
    expect(up.disabled).toBe(true);
    expect(down.disabled).toBe(true);
  });
});
