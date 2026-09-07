import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { PreviewPanel } from "../preview-panel";

describe("PreviewPanel", () => {
  test("is the .pvbox: full width, its own ground, a rule beneath, rounded top only", () => {
    const { container } = render(
      <PreviewPanel>
        <span data-testid="picture" />
      </PreviewPanel>,
    );
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.className).toContain("w-full");
    expect(panel.className).toContain("bg-background");
    expect(panel.className).toContain("border-b");
    expect(panel.className).toContain("border-border");
    expect(panel.className).toContain("rounded-t-md");
    expect(panel.className).not.toContain("rounded-b");
    expect(panel.style.height).toBe("132px");
  });

  test("the height is prop-overridable", () => {
    const { container } = render(
      <PreviewPanel height={96}>
        <span />
      </PreviewPanel>,
    );
    expect((container.firstElementChild as HTMLElement).style.height).toBe("96px");
  });

  test("the caption is optional: present and decorative when given, absent otherwise", () => {
    const { container, rerender } = render(
      <PreviewPanel caption="6 creatives">
        <span />
      </PreviewPanel>,
    );
    const withCaption = container.firstElementChild as HTMLElement;
    const caption = Array.from(withCaption.querySelectorAll("span")).find((span) =>
      span.className.includes("font-mono"),
    );
    expect(caption?.textContent).toBe("6 creatives");
    expect(caption?.getAttribute("aria-hidden")).toBe("true");
    expect(caption?.className).toContain("text-text-muted");
    expect(caption?.className).toContain("text-[10px]");

    rerender(
      <PreviewPanel>
        <span />
      </PreviewPanel>,
    );
    const withoutCaption = container.firstElementChild as HTMLElement;
    expect(Array.from(withoutCaption.querySelectorAll("span")).some((span) => span.className.includes("font-mono"))).toBe(false);
  });

  test("dimmed toggles the unselected treatment — a transition, never a loop (D88)", () => {
    const { container, rerender } = render(
      <PreviewPanel>
        <span />
      </PreviewPanel>,
    );
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.className).toContain("opacity-100");
    expect(panel.className).toContain("saturate-100");
    expect(panel.className).not.toContain("opacity-[0.55]");

    rerender(
      <PreviewPanel dimmed>
        <span />
      </PreviewPanel>,
    );
    const dimmed = container.firstElementChild as HTMLElement;
    expect(dimmed.className).toContain("opacity-[0.55]");
    expect(dimmed.className).toContain("saturate-[0.45]");
    expect(dimmed.className).not.toContain("opacity-100");
  });

  test("the dim is a transition on the panel itself, not an animation", () => {
    const { container } = render(
      <PreviewPanel dimmed>
        <span />
      </PreviewPanel>,
    );
    const panel = container.firstElementChild as HTMLElement;
    expect(panel.className).toContain("transition-[opacity,filter]");
    expect(panel.className).not.toMatch(/animate-/);
  });
});
