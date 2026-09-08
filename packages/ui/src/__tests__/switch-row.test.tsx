import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SwitchRow } from "../switch-row";

describe("SwitchRow", () => {
  test("is a real switch named by its label, with the knob as decoration", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<SwitchRow label="Vary the headline too" checked={false} onToggle={onToggle} />);

    const control = screen.getByRole("switch", { name: "Vary the headline too" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    // the knob must not join the name
    expect(control.querySelector("[aria-hidden='true']")).toBeTruthy();
    await user.click(control);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  test("carries a status line when given one, and none when not", () => {
    const { unmount } = render(
      <SwitchRow label="Headlines" checked onToggle={vi.fn()}>
        2 approved headlines
      </SwitchRow>,
    );
    expect(screen.getByText("2 approved headlines")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Headlines" }).getAttribute("aria-checked")).toBe("true");
    unmount();

    render(<SwitchRow label="Headlines" checked={false} onToggle={vi.fn()} />);
    expect(screen.queryByText("2 approved headlines")).toBeNull();
  });

  test("gating blocks the switch, and the click with it", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<SwitchRow label="Headlines" checked={false} onToggle={onToggle} disabled />);
    const control = screen.getByRole("switch", { name: "Headlines" }) as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    await user.click(control);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
