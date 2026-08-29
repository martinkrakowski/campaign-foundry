import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PreviewFrame } from "../PreviewFrame";

describe("PreviewFrame", () => {
  test("renders children in an aria-hidden preview container", () => {
    const { container } = render(
      <PreviewFrame className="custom-class">
        <span>Child content</span>
      </PreviewFrame>,
    );
    expect(screen.getByText("Child content")).toBeTruthy();
    expect((container.firstChild as HTMLElement).getAttribute("aria-hidden")).toBe("true");
    expect((container.firstChild as HTMLElement).className).toContain("custom-class");
  });
});
