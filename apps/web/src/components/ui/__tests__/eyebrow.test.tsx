import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Eyebrow } from "../eyebrow";

describe("Eyebrow", () => {
  test("renders the group-label pattern with the eyebrow tracking token", () => {
    render(<Eyebrow>Headlines</Eyebrow>);
    const el = screen.getByText("Headlines");
    expect(el.tagName).toBe("SPAN");
    expect(el.className).toContain("font-mono");
    expect(el.className).toContain("text-[11px]");
    expect(el.className).toContain("uppercase");
    // The token, not Tailwind's tracking-widest: the value is stated once.
    expect(el.className).toContain("tracking-eyebrow");
    expect(el.className).not.toContain("tracking-widest");
    expect(el.className).toContain("text-text-muted");
  });

  test("can be a heading, so a list's label stays in the document outline", () => {
    render(<Eyebrow as="h4">Assets (3)</Eyebrow>);
    const el = screen.getByRole("heading", { name: "Assets (3)", level: 4 });
    expect(el.tagName).toBe("H4");
    expect(el.className).toContain("tracking-eyebrow");
  });

  test("can be a table header, so a table's column labels keep their semantics", () => {
    render(
      <table>
        <thead>
          <tr>
            <Eyebrow as="th">Asset Target</Eyebrow>
          </tr>
        </thead>
      </table>,
    );
    const el = screen.getByText("Asset Target");
    expect(el.tagName).toBe("TH");
    expect(el.className).toContain("tracking-eyebrow");
  });

  test("a caller's className is merged over the pattern", () => {
    render(<Eyebrow as="p" className="hidden lg:inline">
      HITL Mode Active
    </Eyebrow>);
    const el = screen.getByText("HITL Mode Active");
    expect(el.tagName).toBe("P");
    expect(el.className).toContain("hidden");
    expect(el.className).toContain("lg:inline");
    expect(el.className).toContain("text-text-muted");
  });
});
