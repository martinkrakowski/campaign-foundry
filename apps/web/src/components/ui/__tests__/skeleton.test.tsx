import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Skeleton } from "../skeleton";

describe("Skeleton", () => {
  test("is a surface-2 block with no dimension of its own to announce", () => {
    const { container } = render(<Skeleton />);
    const el = container.querySelector("div") as HTMLElement;
    expect(el.className).toContain("bg-surface-2");
    expect(el.className).toContain("rounded-md");
    // The block is decoration; the caller's role="status" sentence carries the state.
    expect(el.getAttribute("aria-hidden")).toBe("true");
  });

  test("is static — a fifth loop would break D27's four-animation budget", () => {
    const { container } = render(<Skeleton />);
    const el = container.querySelector("div") as HTMLElement;
    expect(el.className).not.toContain("animate-");
  });

  test("a caller's className overrides the default block size", () => {
    const { container } = render(<Skeleton className="h-12 w-2/3" />);
    const el = container.querySelector("div") as HTMLElement;
    expect(el.className).toContain("h-12");
    expect(el.className).toContain("w-2/3");
    // tailwind-merge drops the default width the caller replaced, keeping one winner.
    expect(el.className).not.toContain("w-full");
  });

  test("stays out of the accessibility tree even when several stand in for a list", () => {
    render(
      <div>
        <Skeleton className="h-12" />
        <Skeleton className="h-12" />
        <p role="status">Loading headlines…</p>
      </div>,
    );
    // Nothing queryable by role: the two blocks are hidden, the sentence is the state.
    expect(screen.getByRole("status").textContent).toBe("Loading headlines…");
  });
});
