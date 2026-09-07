import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { ScrubBar } from "../scrub-bar";

describe("ScrubBar", () => {
  test("is a track with two ticks and the head parked at ~30% — static, always", () => {
    const { container } = render(<ScrubBar />);
    const track = container.firstElementChild as HTMLElement;
    expect(track.getAttribute("aria-hidden")).toBe("true");
    expect(track.className).toContain("rounded-full");
    expect(track.className).toContain("bg-text-muted/[0.18]");
    const children = Array.from(track.children) as HTMLElement[];
    expect(children).toHaveLength(3);
    const ticks = children.slice(0, 2);
    expect(ticks.map((tick) => tick.style.left)).toEqual(["33%", "66%"]);
    const head = children[2];
    expect(head.style.left).toBe("30%");
    expect(head.className).toContain("bg-brand-primary");
    // The head does not move: no animation classes, anywhere (D88).
    for (const element of [track, ...children]) {
      expect(element.className).not.toMatch(/animate-/);
    }
  });
});
