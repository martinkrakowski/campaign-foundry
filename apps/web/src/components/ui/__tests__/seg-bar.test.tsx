import { describe, test, expect, vi } from "vitest";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import config from "../../../../tailwind.config";
import { SegBar, type SegBarSegment } from "../seg-bar";
import * as messages from "@/components/campaign/messages";

/**
 * The walk, as the editor hands it over: six entries mapped off the step list the
 * cursor already walks (W6.1). The segbar never spells this order itself.
 */
const steps: SegBarSegment[] = [
  { id: "identity", label: "Identity", issues: 0 },
  { id: "copy", label: "Copy", issues: 0 },
  { id: "products", label: "Products", issues: 0 },
  { id: "treatments", label: "Treatments", issues: 0 },
  { id: "output", label: "Output", issues: 0 },
  { id: "review", label: "Review", issues: 0 },
];

const segments = (): HTMLButtonElement[] =>
  screen.getAllByRole("button") as HTMLButtonElement[];
const nameOf = (position: number) => segments()[position].getAttribute("aria-label");

describe("SegBar", () => {
  test("renders one segment per step, in the list's own order", () => {
    render(<SegBar segments={steps} index={0} maxVisited={0} onSelect={() => {}} />);
    expect(segments()).toHaveLength(steps.length);
    // The whole walk is named from the labels it was handed — no second copy of the
    // step order lives here to drift from the cursor's.
    expect(segments().map((s) => s.getAttribute("aria-label"))).toEqual(
      steps.map((step, position) =>
        messages.segBarSegment(position + 1, steps.length, step.label, position === 0 ? "current" : "unvisited"),
      ),
    );
  });

  test("the current segment is the only one marked as the current step", () => {
    render(<SegBar segments={steps} index={2} maxVisited={4} onSelect={() => {}} />);
    expect(segments()[2].getAttribute("aria-current")).toBe("step");
    expect(
      segments()
        .filter((s) => s.getAttribute("aria-current") === "step")
        .map((s) => s.getAttribute("aria-label")),
    ).toEqual([nameOf(2)]);
  });

  test("a step behind the cursor reads as done, and one with something to fix reads as that", () => {
    const withIssues = steps.map((step) =>
      step.id === "copy" ? { ...step, issues: 2 } : step,
    );
    render(<SegBar segments={withIssues} index={5} maxVisited={5} onSelect={() => {}} />);
    expect(nameOf(0)).toContain("done");
    expect(nameOf(1)).toContain("has something to fix");
    // The step being shown is named for being shown, not for what it still needs.
    expect(nameOf(5)).toContain("current step");
  });

  test("a step past the furthest reached reads as not started — and is still a live control", () => {
    render(<SegBar segments={steps} index={0} maxVisited={1} onSelect={() => {}} />);
    expect(nameOf(4)).toContain("not filled in yet");
    // No lock (D21): the mock greyed these out while its own sidebar rows walked
    // straight past the lock. A disabled control whose reason is off-screen.
    for (const segment of segments()) expect(segment.disabled).toBe(false);
  });

  test("every segment navigates, including one never visited", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SegBar segments={steps} index={0} maxVisited={0} onSelect={onSelect} />);
    // The review step, from the first step, without having walked there: a step is
    // not gated on the ones before it (D3).
    await user.click(segments()[5]);
    expect(onSelect).toHaveBeenCalledWith(5);
  });

  test("the hover growth is gated behind motion-safe, so reduced motion gets a still bar", () => {
    render(<SegBar segments={steps} index={0} maxVisited={0} onSelect={() => {}} />);
    const tokens = (segments()[0].querySelector("span")?.className ?? "").split(/\s+/);
    // A transform is motion: `motion-safe:` is what keeps a visitor who asked for
    // less of it from being moved by a bar they only pointed at.
    expect(tokens).toContain("motion-safe:group-hover:scale-y-[1.4]");
    expect(tokens).not.toContain("group-hover:scale-y-[1.4]");
  });
});

/**
 * The classes the segbar paints with have to reach the stylesheet. A Tailwind
 * utility that emits nothing is the defect lane W0 existed to fix, and `alpha`
 * on a token was how it hid.
 */
describe("SegBar utilities emit", () => {
  const compile = async (classes: string[]) => {
    const html = classes.map((c) => `<div class="${c}"></div>`).join("\n");
    const result = await postcss([
      tailwindcss({ ...config, content: [{ raw: html, extension: "html" }] }),
    ]).process("@tailwind utilities;", { from: undefined });
    return result.css;
  };

  test("the hover scale and the four state fills all reach the stylesheet", async () => {
    const css = await compile([
      "motion-safe:group-hover:scale-y-[1.4]",
      "motion-safe:transition-transform",
      "motion-safe:duration-fast",
      "bg-brand-primary",
      "bg-brand-primary/40",
      "bg-error",
      "bg-border",
    ]);
    expect(css).toContain(".group:hover .motion-safe\\:group-hover\\:scale-y-\\[1\\.4\\]");
    expect(css).toContain("--tw-scale-y: 1.4");
    expect(css).toContain(".motion-safe\\:transition-transform");
    expect(css).toContain(".motion-safe\\:duration-fast");
    expect(css).toContain(".bg-brand-primary\\/40");
    expect(css).toContain(".bg-error");
    expect(css).toContain(".bg-border");
  });
});
