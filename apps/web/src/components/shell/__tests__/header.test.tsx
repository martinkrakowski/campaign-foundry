import { describe, test, expect, afterEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun } from "@/__tests__/helpers";
import { Header } from "../Header";

// The theme toggle writes to <html>, which is shared by every test in this file and is
// not the element `cleanup()` unmounts — the next test would inherit a light theme.
afterEach(() => {
  document.documentElement.classList.add("dark");
  localStorage.clear();
});

describe("Header", () => {
  test("the mobile menu trigger is a 32px icon control, named and marked as a popup", () => {
    renderWithRun(<Header />);

    // Its name is a contract: the suite and the mobile menu's own tests reach the
    // trigger by "Open menu", and an icon-only button has no text to fall back on.
    const trigger = screen.getByLabelText("Open menu");
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.className).toContain("size-8");
    expect(trigger.className).toContain("flex-none");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("the trigger opens the menu dialog and reports it as expanded", async () => {
    const user = userEvent.setup();
    renderWithRun(<Header />);

    await user.click(screen.getByLabelText("Open menu"));

    expect(screen.getByRole("dialog", { name: "Menu" })).toBeTruthy();
    expect(screen.getByLabelText("Open menu").getAttribute("aria-expanded")).toBe("true");
  });

  test("the mode badge is an eyebrow on the tracking token, keeping its own 10px size", () => {
    renderWithRun(<Header />);
    const badge = screen.getByText("HITL Mode Active");
    expect(badge.className).toContain("tracking-eyebrow");
    expect(badge.className).not.toContain("tracking-widest");
    // The eyebrow's 11px is the default; this one overrides it rather than growing
    // the header line, and tailwind-merge keeps a single winner.
    expect(badge.className).toContain("text-[10px]");
    expect(badge.className).not.toContain("text-[11px]");
  });

  test("the header carries the theme toggle, named for the action it performs", async () => {
    const user = userEvent.setup();
    renderWithRun(<Header />);

    // Reachable by its name alone: it is the only control in the app that says this.
    const toggle = screen.getByRole("button", { name: "Switch to the light theme" });
    expect(toggle.className).toContain("size-8");

    await user.click(toggle);

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("cf:theme")).toBe("light");
    expect(screen.getByRole("button", { name: "Switch to the dark theme" })).toBeTruthy();
  });
});
