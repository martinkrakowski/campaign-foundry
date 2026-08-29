import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MotionKindPanel, MOTION_KIND_META, MOTION_KINDS } from "../MotionKindPanel";

describe("MotionKindPanel", () => {
  test("defines meta captions for all four motion kinds", () => {
    for (const kind of MOTION_KINDS) {
      expect(MOTION_KIND_META[kind]).toBeTruthy();
      expect(typeof MOTION_KIND_META[kind]).toBe("string");
    }
  });

  test("renders motion kind card and dispatches toggle", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <MotionKindPanel
        kind="ken-burns-in"
        selected={true}
        onToggle={onToggle}
      />,
    );

    const button = screen.getByRole("button", { name: "ken-burns-in" });
    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("slow zoom in")).toBeTruthy();

    await user.click(button);
    expect(onToggle).toHaveBeenCalledWith("ken-burns-in");
  });

  test("respects disabled prop", () => {
    render(
      <MotionKindPanel
        kind="accent-wipe"
        selected={false}
        onToggle={vi.fn()}
        disabled={true}
      />,
    );

    expect((screen.getByRole("button", { name: "accent-wipe" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("soft fade beneath band")).toBeTruthy();
  });
});
