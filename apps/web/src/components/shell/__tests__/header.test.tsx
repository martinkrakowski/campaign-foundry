import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, useEffect, type ReactElement } from "react";
import { nextMock, renderWithRun, ShellProviders } from "@/__tests__/helpers";
import { useEditorDirty } from "@/lib/editor-dirty-context";
import { useRun } from "@/lib/run-context";
import {
  generateNoBrief,
  modelChanged,
  telemetryButton,
} from "@/components/campaign/messages";
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

/** Commits a brief the way Apply does — the one thing that turns Generate into a run. */
const ApplyBrief = () => {
  const { brief, setBrief } = useRun();
  return (
    <button type="button" onClick={() => setBrief({ ...brief, id: "applied-brief" })}>
      apply
    </button>
  );
};

/** POSTs to the generate endpoint — the proof that a run really was started. */
const generatePosts = () =>
  vi.mocked(globalThis.fetch).mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST",
  );

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

describe("Header — the Brief tab (D33)", () => {
  test.each(["/brief", "/brief/new"])("the Brief tab is the current page on %s", (path) => {
    nextMock().nav.pathname = path;
    renderWithRun(<Header />);

    expect(screen.getByRole("link", { name: "Brief" }).getAttribute("aria-current")).toBe("page");
    // The two routes share a prefix, so the tab stays current on both — and no other
    // tab's href is a prefix of another, which is what makes that test safe.
    expect(screen.getByRole("link", { name: "Grid" }).getAttribute("aria-current")).toBeNull();
  });
});

describe("Header — Generate (D32)", () => {
  beforeEach(() => localStorage.setItem("cf:brief-picked", "1"));

  test("with nothing applied it refuses out loud and routes to the brief, not to the grid", async () => {
    const user = userEvent.setup();
    nextMock().nav.pathname = "/grid";
    renderWithRun(<Header />);

    await user.click(screen.getByRole("button", { name: "Generate" }));

    // Never disabled (D3): the press is the question, and this is the answer — what is
    // missing, and the control that fixes it.
    expect(screen.getByRole("status").textContent).toBe(generateNoBrief);
    expect(nextMock().router.push).toHaveBeenCalledWith("/brief");
    expect(nextMock().router.push).not.toHaveBeenCalledWith("/grid");
    expect(generatePosts()).toHaveLength(0);
  });

  test("on the brief route it says what is missing without navigating anywhere", async () => {
    const user = userEvent.setup();
    nextMock().nav.pathname = "/brief";
    renderWithRun(<Header />);

    await user.click(screen.getByRole("button", { name: "Generate" }));

    // The remedy (Apply, in the editor's action bar) is already on screen here, so the
    // reveal needs no route change.
    expect(screen.getByRole("status").textContent).toBe(generateNoBrief);
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("with an applied brief it runs the brief and takes the user to the grid", async () => {
    const user = userEvent.setup();
    renderWithRun(
      <>
        <ApplyBrief />
        <Header />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "apply" }));

    await user.click(screen.getByRole("button", { name: "Generate" }));

    expect(generatePosts()).toHaveLength(1);
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("a prompt the user refuses leaves the run unstarted", async () => {
    const user = userEvent.setup();
    renderDirty(
      <>
        <ApplyBrief />
        <Header />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "apply" }));

    await user.click(screen.getByRole("button", { name: "Generate" }));
    // Leaving a dirty draft is the guard's question, and staying is an answer that
    // must cancel the run rather than fire it behind the user's back.
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));

    expect(generatePosts()).toHaveLength(0);
    expect(nextMock().router.push).not.toHaveBeenCalled();
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
