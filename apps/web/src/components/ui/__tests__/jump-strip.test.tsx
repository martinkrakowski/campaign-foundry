import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JumpStrip } from "../jump-strip";

const ITEMS = [
  { key: "identity", label: "Identity", count: 1 },
  { key: "output", label: "Output", count: 3 },
] as const;

describe("JumpStrip", () => {
  test("one chip per failing section, labelled by the caller, carrying its count", () => {
    const { container } = render(<JumpStrip items={ITEMS} />);
    expect(screen.getByRole("button", { name: "Identity 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Output 3" })).toBeTruthy();
    // the count badge is the numeral's visual; the label spells the destination
    expect(container.querySelectorAll("button")).toHaveLength(2);
  });

  test("a press reports the chip's key to the caller", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(<JumpStrip items={ITEMS} onJump={onJump} />);
    await user.click(screen.getByRole("button", { name: "Output 3" }));
    expect(onJump).toHaveBeenCalledWith("output");
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  test("without a jump handler a press is still safe", async () => {
    const user = userEvent.setup();
    render(<JumpStrip items={ITEMS} />);
    await user.click(screen.getByRole("button", { name: "Identity 1" }));
  });

  test("nothing to jump to renders nothing", () => {
    const { container } = render(<JumpStrip items={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
