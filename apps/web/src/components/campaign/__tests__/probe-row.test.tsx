import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProbeRow } from "../ProbeRow";

describe("ProbeRow", () => {
  const row = () => screen.getByLabelText("Capabilities probe");

  test("renders probing state when capabilities is null or 'not probed'", () => {
    const { rerender } = render(<ProbeRow capabilities={null} />);
    const el = row();
    expect(el.textContent).toContain("ffmpeg");
    expect(el.textContent).toContain("probing…");

    rerender(<ProbeRow capabilities={{ motion: false, reason: "not probed" }} />);
    expect(row().textContent).toContain("probing…");
  });

  test("renders found state with optional version", () => {
    const { rerender } = render(<ProbeRow capabilities={{ motion: true }} />);
    expect(row().textContent).toContain("found");

    rerender(<ProbeRow capabilities={{ motion: true, version: "6.1.1" }} />);
    const text = row().textContent!;
    expect(text).toContain("found");
    expect(text).toContain("6.1.1");
  });

  test("renders not available state with reason", () => {
    render(<ProbeRow capabilities={{ motion: false, reason: "not found" }} />);
    const text = row().textContent!;
    expect(text).toContain("not available");
    expect(text).toContain("not found");
  });
});
