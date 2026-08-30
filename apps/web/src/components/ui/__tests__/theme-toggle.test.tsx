import { describe, test, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "../theme-toggle";
import { THEME_CLASS, THEME_STORAGE_KEY } from "@/lib/theme";

const toggle = () => screen.getByRole("button");
const isDark = () => document.documentElement.classList.contains(THEME_CLASS);
/** The sun carries a `circle`; the moon is a single path. The icon is decoration — this
    only proves the two states are different pictures, not the same one. */
const showsSun = () => toggle().querySelector("circle") !== null;

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.classList.add(THEME_CLASS);
});

describe("ThemeToggle", () => {
  test("it is the header's 32px icon control, and its name says what a press will do", () => {
    render(<ThemeToggle />);
    expect(toggle().className).toContain("size-8");
    // Not "Light theme": a name that states the state leaves a screen reader announcing
    // where the user already is and says nothing about the button they are on.
    expect(toggle().getAttribute("aria-label")).toBe("Switch to the light theme");
    expect(toggle().hasAttribute("aria-pressed")).toBe(false);
  });

  test("a press switches to light: the class comes off, the choice is stored, the name flips", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    expect(showsSun()).toBe(true);

    await user.click(toggle());

    expect(isDark()).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(toggle().getAttribute("aria-label")).toBe("Switch to the dark theme");
    expect(showsSun()).toBe(false);
  });

  test("a second press round-trips to dark, and the stored choice follows it", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(toggle());
    await user.click(toggle());

    expect(isDark()).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(toggle().getAttribute("aria-label")).toBe("Switch to the light theme");
  });

  test("a light theme stored by an earlier visit is adopted on mount", () => {
    // The server renders dark; the boot script has already corrected the class by now.
    // This is the component catching up with it, so its name matches what is painted.
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    render(<ThemeToggle />);
    expect(toggle().getAttribute("aria-label")).toBe("Switch to the dark theme");
    expect(isDark()).toBe(false);
  });

  test("a dark theme stored by an earlier visit leaves the server's class in place", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    render(<ThemeToggle />);
    expect(isDark()).toBe(true);
    expect(toggle().getAttribute("aria-label")).toBe("Switch to the light theme");
  });

  test("a store that refuses the write still switches — the choice holds for this page", async () => {
    const user = userEvent.setup();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    render(<ThemeToggle />);

    await user.click(toggle());

    expect(isDark()).toBe(false);
    expect(toggle().getAttribute("aria-label")).toBe("Switch to the dark theme");
  });

  test("no storage at all still switches, and never throws", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("localStorage", undefined);
    render(<ThemeToggle />);

    await user.click(toggle());

    expect(isDark()).toBe(false);
    expect(toggle().getAttribute("aria-label")).toBe("Switch to the dark theme");
  });
});
