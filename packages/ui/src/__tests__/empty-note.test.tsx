import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyNote } from "../empty-note";

describe("EmptyNote", () => {
  test("renders title, message, and children", () => {
    render(
      <EmptyNote
        title="Empty Heading"
        message="Empty description details"
      >
        <button type="button">Action</button>
      </EmptyNote>,
    );

    expect(screen.getByText("Empty Heading")).toBeTruthy();
    expect(screen.getByText("Empty description details")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Action" })).toBeTruthy();
  });

  test("renders with only message", () => {
    render(<EmptyNote message="Simple note" />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Simple note")).toBeTruthy();
  });

  test("renders with only title", () => {
    render(<EmptyNote title="Title only" />);
    expect(screen.getByRole("heading", { name: "Title only" })).toBeTruthy();
  });
});
