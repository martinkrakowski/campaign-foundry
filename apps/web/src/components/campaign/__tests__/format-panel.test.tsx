import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormatPanel, formatGate } from "../FormatPanel";
import * as messages from "../messages";

describe("formatGate", () => {
  test("static format is never gated", () => {
    const gate = formatGate("static", { mode: "brief", formats: ["static"] }, { motion: false });
    expect(gate).toEqual({ gated: false, disabled: false });
  });

  test("motion format is gated when capabilities.motion is false and unselected", () => {
    const gate = formatGate("motion", { mode: "variation", formats: ["static"] }, { motion: false });
    expect(gate).toEqual({
      gated: true,
      disabled: true,
      description: messages.formatsMotionUnavailable,
    });
  });

  test("motion format allows deselecting when capabilities.motion is false and already selected", () => {
    const gate = formatGate("motion", { mode: "variation", formats: ["static", "motion"] }, { motion: false });
    expect(gate).toEqual({
      gated: true,
      disabled: false,
      description: messages.formatsMotionUnavailable,
    });
  });

  test("motion format is gated when mode is brief (Classic) and unselected", () => {
    const gate = formatGate("motion", { mode: "brief", formats: ["static"] }, { motion: true });
    expect(gate).toEqual({
      gated: true,
      disabled: true,
      description: messages.formatsMotionNeedsRandomized,
    });
  });

  test("motion format is ungated when mode is variation and host has motion", () => {
    const gate = formatGate("motion", { mode: "variation", formats: ["static"] }, { motion: true });
    expect(gate).toEqual({ gated: false, disabled: false });
  });
});

describe("FormatPanel", () => {
  test("renders static format card with still meta caption", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <FormatPanel
        format="static"
        selected={true}
        onToggle={onToggle}
      />,
    );

    const button = screen.getByRole("button", { name: "static" });
    expect(button).toBeTruthy();
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("still · one frame")).toBeTruthy();

    await user.click(button);
    expect(onToggle).toHaveBeenCalledWith("static");
  });

  test("renders motion format card with motion meta caption and gate description", () => {
    const gate = {
      gated: true,
      disabled: true,
      description: "Gated reason",
    };
    render(
      <FormatPanel
        format="motion"
        selected={false}
        onToggle={vi.fn()}
        gate={gate}
      />,
    );

    const button = screen.getByRole("button", { name: "motion" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/clip · 30 fps · 2–30 s/)).toBeTruthy();
    expect(screen.getByText("Gated reason")).toBeTruthy();
  });
});

describe("FormatPanel says what it is, and shows what it means", () => {
  test("the screen reads the display name while the accessible name stays the raw value", () => {
    render(<FormatPanel format="motion" selected={false} onToggle={vi.fn()} />);
    // D18: "motion" is what the brief stores and what assistive tech and the YAML agree on;
    // "Video" is what a person reads. Both, not one standing in for the other.
    const card = screen.getByRole("button", { name: "motion" });
    expect(card.textContent).toContain("Video");
    expect(card.textContent).not.toContain("motion");
  });
});
