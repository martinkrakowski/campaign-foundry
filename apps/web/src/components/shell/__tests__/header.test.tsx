import { describe, test, expect, afterEach, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, useEffect, type ReactElement } from "react";
import { nextMock, renderWithRun, ShellProviders } from "@/__tests__/helpers";
import { useEditorDirty } from "@/lib/editor-dirty-context";
import { modelChanged, telemetryButton } from "@/components/campaign/messages";
import { Header } from "../Header";

// The theme toggle writes to <html>, which is shared by every test in this file and is
// not the element `cleanup()` unmounts — the next test would inherit a light theme.
afterEach(() => {
  document.documentElement.classList.add("dark");
  localStorage.clear();
});

/** Raises the editor's dirty flag, so any guarded navigation has to prompt. */
const RaiseDirty = () => {
  const { setDirty } = useEditorDirty();
  useEffect(() => setDirty(true), [setDirty]);
  return null;
};

const renderDirty = (ui: ReactElement) =>
  render(createElement(ShellProviders, null, createElement(RaiseDirty), ui));

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

  // SG-D10 — the owner retracted this placement as an error, so the absence is the
  // contract, not an incidental. Asserted on the header ALONE: the verb still exists
  // in the app (the editor's action bar) and on the grid (`CommandBar`), so a test
  // that searched the whole document would pass with the button back in this bar.
  test("the header carries no run verb at all — Generate left it (SG-D10)", () => {
    renderWithRun(<Header />);

    const bar = screen.getByRole("banner");
    expect(within(bar).queryByRole("button", { name: "Generate" })).toBeNull();
    expect(within(bar).queryByRole("button", { name: "Validate" })).toBeNull();
    // Nor by any other name: no dialog-opening verb is left in this bar besides the
    // hamburger, so nothing here can start a run or ask about one.
    const popupVerbs = within(bar)
      .getAllByRole("button")
      .filter((el) => el.getAttribute("aria-haspopup") === "dialog")
      .map((el) => el.getAttribute("aria-label") ?? el.getAttribute("title"));
    expect(popupVerbs).toEqual(["Change image model", "Open menu"]);
  });
});

describe("Header — the Brief tab (D33)", () => {
  test.each(["/brief", "/brief/new"])("the Brief tab is the current page on %s", (path) => {
    nextMock().nav.pathname = path;
    renderWithRun(<Header />);

    expect(screen.getByRole("link", { name: "Brief" }).getAttribute("aria-current")).toBe("page");
    // The two routes share a prefix, so the tab stays current on both — and no other
    // tab's href is a prefix of another, which is what makes that test safe. Assert
    // every other tab, not just one: a prefix bug would mark a specific tab, and
    // checking a single sibling can only catch it if that is the one it marks.
    for (const other of ["Grid", "Compliance", "Export", "Runs"]) {
      expect(screen.getByRole("link", { name: other }).getAttribute("aria-current")).toBeNull();
    }
  });
});

describe("Header — the brand mark and the telemetry control", () => {
  beforeEach(() => localStorage.setItem("cf:brief-picked", "1"));

  test("the brand mark goes home through the guard, prompting exactly once", async () => {
    const user = userEvent.setup();
    nextMock().router.push.mockClear();
    renderDirty(<Header />);

    await user.click(screen.getByRole("link", { name: /Campaign Pipeline/ }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });

    await user.click(within(dialog).getByRole("button", { name: "Leave" }));
    expect(nextMock().router.push).toHaveBeenCalledTimes(1);
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
  });

  // The same guard lane W1 added to MobileMenu, which was never mirrored here: a
  // modified or non-primary click is the browser's own job (new tab / new window /
  // download) and must not be intercepted into a dirty prompt.
  test.each(["metaKey", "ctrlKey", "shiftKey", "altKey", "button"] as const)(
    "a %s click on the brand mark is left to the browser, even with unsaved edits",
    (modifier) => {
      nextMock().router.push.mockClear();
      renderDirty(<Header />);
      fireEvent.click(screen.getByRole("link", { name: /Campaign Pipeline/ }), {
        [modifier]: modifier === "button" ? 1 : true,
      });
      expect(nextMock().router.push).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
    },
  );

  test("a brand-mark prompt the user refuses does not navigate", async () => {
    const user = userEvent.setup();
    nextMock().router.push.mockClear();
    renderDirty(<Header />);

    await user.click(screen.getByRole("link", { name: /Campaign Pipeline/ }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));

    // Staying is an answer, and it must hold the user where they are — the guard's
    // whole contract is that a refused action never fires.
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("the telemetry button opens the drawer and asks the dirty guard nothing", async () => {
    const user = userEvent.setup();
    renderDirty(<Header />);

    // A panel, not a dialog, and it changes no draft: a press must never prompt, even
    // with unsaved edits standing.
    const button = screen.getByLabelText(telemetryButton);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    await user.click(button);

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("changing the image model says which model the next run will use", async () => {
    const user = userEvent.setup();
    renderWithRun(<Header />);

    await user.click(screen.getByTitle("Change image model"));
    const dialog = await screen.findByRole("dialog", { name: "Select image model" });
    await user.click(within(dialog).getByText("Procedural (offline)"));

    expect(screen.getByRole("status").textContent).toBe(modelChanged("Procedural (offline)"));
  });
});
