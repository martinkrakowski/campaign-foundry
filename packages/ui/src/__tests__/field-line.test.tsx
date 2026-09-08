import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FieldLine } from "../field-line";

describe("FieldLine", () => {
  test("defaults to a muted hint", () => {
    render(<FieldLine>Fewest creatives each shape must get</FieldLine>);
    const el = screen.getByText("Fewest creatives each shape must get");
    expect(el.tagName).toBe("P");
    expect(el.className).toContain("text-[11px]");
    expect(el.className).toContain("text-text-muted");
  });

  test("an error takes the error token and no live region", () => {
    render(<FieldLine tone="error">No platform chosen</FieldLine>);
    const el = screen.getByText("No platform chosen");
    expect(el.className).toContain("text-error");
    // GB-D1 gates when this appears; announcing it would narrate the form and would
    // put red on a blank brief.
    expect(el.getAttribute("role")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a warning is *cannot run here*, not an error", () => {
    render(<FieldLine tone="warning">Video needs ffmpeg</FieldLine>);
    expect(screen.getByText("Video needs ffmpeg").className).toContain("text-warning");
  });

  test("a caller's className is merged over the primitive's own", () => {
    render(<FieldLine tone="error" className="block">
      Choose at least one format
    </FieldLine>);
    const el = screen.getByText("Choose at least one format");
    expect(el.className).toContain("block");
    expect(el.className).toContain("text-error");
  });
});
