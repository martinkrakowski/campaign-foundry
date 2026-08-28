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
    expect(screen.getByTestId("paint")).toBeTruthy();
    expect(card.textContent).toContain("A pattern we draw");
    await user.click(card);
    expect(onToggle).toHaveBeenCalledWith("procedural");
  });

  test("selected shows the check mark, unselected shows none", () => {
    const { unmount } = render(
      <PreviewCard value="genai" selected meta="Made by AI" onToggle={vi.fn()}>
        {paint}
      </PreviewCard>,
    );
    const selected = screen.getByRole("button", { name: "genai" });
    expect(selected.getAttribute("aria-pressed")).toBe("true");
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
