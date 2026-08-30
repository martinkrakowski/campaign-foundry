import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PreviewCard } from "../preview-card";

const paint = <svg data-testid="paint" />;

describe("PreviewCard", () => {
  test("is named by the raw value, with the picture and caption as decoration", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <PreviewCard value="procedural" selected={false} meta="A pattern we draw" onToggle={onToggle}>
        {paint}
      </PreviewCard>,
    );

    const card = screen.getByRole("button", { name: "procedural" });
    expect(card.getAttribute("aria-pressed")).toBe("false");
    expect(card.className).toContain("border-[1.5px]");
    expect(card.className).toContain("border-border");
    expect(card.className).toContain("bg-surface-2");
    expect(screen.getByTestId("paint")).toBeTruthy();
    expect(card.textContent).toContain("A pattern we draw");

    // 44px preview tile at rest
    const tile = card.querySelector("span[aria-hidden='true'].size-11");
    expect(tile?.className).toContain("bg-background");
    expect(tile?.className).toContain("text-text-secondary");

    await user.click(card);
    expect(onToggle).toHaveBeenCalledWith("procedural");
  });

  test("selected shows the check badge and inverts tile, unselected shows none", () => {
    const { unmount } = render(
      <PreviewCard value="genai" selected meta="Made by AI" onToggle={vi.fn()}>
        {paint}
      </PreviewCard>,
    );
    const selected = screen.getByRole("button", { name: "genai" });
    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(selected.className).toContain("border-brand-primary");
    expect(selected.className).toContain("bg-brand-primary/[0.08]");

    // 44px preview tile inverts
    const tile = selected.querySelector("span[aria-hidden='true'].size-11");
    expect(tile?.className).toContain("bg-brand-primary");
    expect(tile?.className).toContain("text-white");

    // 22px check badge with check-pop
    const checkBadge = selected.querySelector("span[aria-hidden='true'].size-\\[22px\\]");
    expect(checkBadge).toBeTruthy();
    expect(checkBadge?.className).toContain("animate-check-pop");
    expect(selected.querySelectorAll("svg").length).toBe(2);
    unmount();

    render(
      <PreviewCard value="genai" selected={false} meta="Made by AI" onToggle={vi.fn()}>
        {paint}
      </PreviewCard>,
    );
    expect(screen.getByRole("button", { name: "genai" }).querySelectorAll("svg").length).toBe(1);
  });

  test("a description is described, never named — the name stays the value", () => {
    render(
      <PreviewCard
        value="genai"
        selected={false}
        meta="Made by AI"
        description="costs an image call"
        onToggle={vi.fn()}
      >
        {paint}
      </PreviewCard>,
    );
    const card = screen.getByRole("button", { name: "genai" });
    const describedBy = card.getAttribute("aria-describedby") as string;
    expect(document.getElementById(describedBy)?.textContent).toBe("costs an image call");
  });

  test("a disabled card refuses the click", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <PreviewCard value="genai" selected={false} meta="Made by AI" onToggle={onToggle} disabled>
        {paint}
      </PreviewCard>,
    );
    await user.click(screen.getByRole("button", { name: "genai" }));
    expect(onToggle).not.toHaveBeenCalled();
  });
});
