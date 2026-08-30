import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MiniChip, type MiniChipTone } from "../mini-chip";

describe("MiniChip", () => {
  test("renders text content with neutral tone by default", () => {
    render(<MiniChip>Status</MiniChip>);
    const chip = screen.getByText("Status");
    expect(chip).toBeTruthy();
    expect(chip.className).toContain("font-mono");
    expect(chip.className).toContain("h-5");
    expect(chip.className).toContain("border-border");
  });

  test.each(["neutral", "success", "warning", "error", "info"] as MiniChipTone[])(
    "renders %s tone correctly",
    (tone) => {
      render(<MiniChip tone={tone} title={`title-${tone}`}>{tone}</MiniChip>);
      const chip = screen.getByTitle(`title-${tone}`);
      expect(chip).toBeTruthy();
      expect(chip.textContent).toBe(tone);
    },
  );
});
