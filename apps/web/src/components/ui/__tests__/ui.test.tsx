import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "../button";
import { Card, CardHeader, CardContent } from "../card";
import { Input } from "../input";

describe("Button", () => {
  test("renders children with default variant/size", () => {
    render(<Button>Go</Button>);
    const b = screen.getByRole("button");
    expect(b.textContent).toContain("Go");
    expect(b.className).toContain("bg-brand-primary");
    expect(b.className).toContain("h-10"); // md
  });

  test("applies an explicit variant and size", () => {
    render(<Button variant="destructive" size="lg">X</Button>);
    const b = screen.getByRole("button");
    expect(b.className).toContain("bg-error");
    expect(b.className).toContain("h-12");
  });

  test("loading state shows a spinner, hides children and disables", () => {
    render(<Button isLoading>Go</Button>);
    const b = screen.getByRole("button") as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.textContent).not.toContain("Go");
  });

  test("honours the disabled prop", () => {
    render(<Button disabled>X</Button>);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Card", () => {
  test("renders children, header and content", () => {
    render(
      <Card>
        <CardHeader>H</CardHeader>
        <CardContent>C</CardContent>
      </Card>,
    );
    expect(screen.getByText("H")).toBeTruthy();
    expect(screen.getByText("C")).toBeTruthy();
  });

  test("renders without children (null fallbacks)", () => {
    const { container } = render(
      <Card>
        <CardHeader />
        <CardContent />
      </Card>,
    );
    expect(container.querySelectorAll("div").length).toBeGreaterThan(0);
  });
});

describe("Input", () => {
  test("is valid by default", () => {
    render(<Input placeholder="name" />);
    const el = screen.getByPlaceholderText("name");
    expect(el.getAttribute("aria-invalid")).toBeNull();
    expect(el.className).toContain("border-border");
  });

  test("reflects the invalid state", () => {
    render(<Input placeholder="name" invalid />);
    const el = screen.getByPlaceholderText("name");
    expect(el.getAttribute("aria-invalid")).toBe("true");
    expect(el.className).toContain("border-error");
  });
});
