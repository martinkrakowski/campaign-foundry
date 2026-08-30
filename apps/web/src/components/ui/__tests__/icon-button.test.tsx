import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IconButton } from "../icon-button";

describe("IconButton", () => {
  test("names an icon-only control from its label", () => {
    render(
      <IconButton label="Close menu">
        <svg aria-hidden="true" />
      </IconButton>,
    );
    // No text to name it, so the label *is* the accessible name.
    expect(screen.getByLabelText("Close menu")).toBeTruthy();
  });

  test("is a 32px square that never shrinks, and centres its glyph", () => {
    render(<IconButton label="Open menu" />);
    const el = screen.getByRole("button", { name: "Open menu" });
    expect(el.className).toContain("size-8");
    expect(el.className).toContain("flex-none");
    expect(el.className).toContain("place-items-center");
    expect(el.className).toContain("rounded-sm");
  });

  test("rests muted and lifts to the emphasis token on hover", () => {
    render(<IconButton label="Close telemetry" />);
    const el = screen.getByRole("button", { name: "Close telemetry" });
    expect(el.className).toContain("text-text-muted");
    expect(el.className).toContain("hover:text-text-emphasis");
  });

  test("defaults to type=button so it never submits a form, but honours an override", () => {
    const { unmount } = render(<IconButton label="Reset" />);
    expect(screen.getByRole("button", { name: "Reset" }).getAttribute("type")).toBe("button");
    unmount();

    render(<IconButton label="Reset" type="submit" />);
    expect(screen.getByRole("button", { name: "Reset" }).getAttribute("type")).toBe("submit");
  });

  test("fires its click handler and forwards the rest of the button props", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton label="Expand telemetry" onClick={onClick} aria-expanded={false} />);

    const el = screen.getByRole("button", { name: "Expand telemetry" });
    expect(el.getAttribute("aria-expanded")).toBe("false");

    await user.click(el);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("a caller's className is merged over the primitive's own", () => {
    render(<IconButton label="Open menu" className="lg:hidden" />);
    const el = screen.getByRole("button", { name: "Open menu" });
    expect(el.className).toContain("lg:hidden");
    expect(el.className).toContain("size-8");
  });
});
