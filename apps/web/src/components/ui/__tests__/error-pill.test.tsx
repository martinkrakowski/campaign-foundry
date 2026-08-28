import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorPill } from "../error-pill";

describe("ErrorPill", () => {
  test("shows the count and says it in words for a screen reader", () => {
    render(<ErrorPill count={1} />);
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByLabelText("1 issue")).toBeTruthy();
  });

  test("pluralises", () => {
    render(<ErrorPill count={3} />);
    expect(screen.getByLabelText("3 issues")).toBeTruthy();
  });

  test("renders nothing when there is nothing to fix", () => {
    const { container } = render(<ErrorPill count={0} />);
    expect(container.firstChild).toBeNull();
  });
});
