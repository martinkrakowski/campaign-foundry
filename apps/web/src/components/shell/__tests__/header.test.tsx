import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, within, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, useEffect, type ReactElement } from "react";
import { nextMock, renderWithRun, ShellProviders } from "@/__tests__/helpers";
import { useEditorDirty } from "@/lib/editor-dirty-context";
import { modelChanged, telemetryButton } from "@/components/campaign/messages";
import * as briefsApi from "@/lib/briefs-api";
import { authClient } from "@/lib/auth-client";
import { Header, MobileAuthSection, BetterAuthSection } from "../Header";

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: vi.fn(() => ({ data: null, isPending: false })),
    useListOrganizations: vi.fn(() => ({ data: null, isPending: false })),
    useActiveOrganization: vi.fn(() => ({ data: null, isPending: false })),
    organization: {
      setActive: vi.fn(),
      list: vi.fn(),
    },
    signOut: vi.fn(),
  },
}));

// `window.location` is shared by every test in this file exactly like `<html>` above —
// a handful of tests overwrite `.assign`/`.reload` with a spy directly (jsdom's own
// Location throws "Not implemented" for both), which is a property assignment, not a
// `vi.spyOn` mock `cleanup()` or `restoreAllMocks` would ever touch. Captured once, so
// a later test's real navigation call reaches this original rather than a stale spy
// from an earlier test.
const originalAssign = window.location.assign.bind(window.location);
const originalReload = window.location.reload.bind(window.location);

// The theme toggle writes to <html>, which is shared by every test in this file and is
// not the element `cleanup()` unmounts — the next test would inherit a light theme.
afterEach(() => {
  document.documentElement.classList.add("dark");
  localStorage.clear();
  window.location.assign = originalAssign;
  window.location.reload = originalReload;
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

    const dialog = screen.getByRole("dialog", { name: "Menu" });
    expect(dialog).toBeTruthy();
    expect(screen.getByLabelText("Open menu").getAttribute("aria-expanded")).toBe("true");

    await user.click(within(dialog).getByLabelText("Close menu"));
    expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull();
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

describe("Header — auth and organization switching (PT-1b2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("under local auth mode, the header is unchanged with no user menu or org switcher", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "local", google: false },
    });

    renderWithRun(<Header />);

    // Wait to ensure capabilities have resolved
    await new Promise((r) => setTimeout(r, 10));

    expect(screen.queryByRole("button", { name: "User menu" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Switch organization" })).toBeNull();

    const bar = screen.getByRole("banner");
    const popupVerbs = within(bar)
      .getAllByRole("button")
      .filter((el) => el.getAttribute("aria-haspopup") === "dialog")
      .map((el) => el.getAttribute("aria-label") ?? el.getAttribute("title"));
    expect(popupVerbs).toEqual(["Change image model", "Open menu"]);

    // PT-1b2 item 4: under local auth, neither `BetterAuthSection` nor
    // `BetterAuthMobileControls` mounts, so the better-auth session/org hooks — each a
    // live subscription, not a free read — are never called. Open the mobile menu too:
    // its `authControls` slot must stay empty rather than mounting the mobile variant.
    expect(authClient.useSession).not.toHaveBeenCalled();
    expect(authClient.useListOrganizations).not.toHaveBeenCalled();
    expect(authClient.useActiveOrganization).not.toHaveBeenCalled();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Open menu"));
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    expect(within(dialog).queryByTestId("mobile-auth-controls")).toBeNull();
    expect(authClient.useSession).not.toHaveBeenCalled();
    expect(authClient.useListOrganizations).not.toHaveBeenCalled();
    expect(authClient.useActiveOrganization).not.toHaveBeenCalled();
  });

  test("under better-auth mode with 1 org, renders user menu but no org switcher", async () => {
    const user = userEvent.setup();
    const assignSpy = vi.fn();
    window.location.assign = assignSpy;

    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "better-auth", google: false },
    });
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { email: "user@example.com" } },
      isPending: false,
    } as never);
    vi.mocked(authClient.useListOrganizations).mockReturnValue({
      data: [{ id: "org-1", name: "Solo Org" }],
      isPending: false,
    } as never);
    vi.mocked(authClient.useActiveOrganization).mockReturnValue({
      data: { id: "org-1", name: "Solo Org" },
      isPending: false,
    } as never);
    const signOutSpy = vi.spyOn(authClient, "signOut").mockResolvedValue({} as never);

    renderWithRun(<Header />);

    const userMenuButton = await screen.findByRole("button", { name: "User menu" });
    expect(userMenuButton.textContent).toContain("user@example.com");
    expect(screen.queryByRole("combobox", { name: "Switch organization" })).toBeNull();

    // Open user menu
    await user.click(userMenuButton);
    expect(screen.getByRole("menu", { name: "User menu" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toBeTruthy();

    // Click outside closes menu
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu", { name: "User menu" })).toBeNull();

    // Open and press non-Escape key doesn't close
    await user.click(userMenuButton);
    expect(screen.getByRole("menu", { name: "User menu" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "x" });
    expect(screen.getByRole("menu", { name: "User menu" })).toBeTruthy();

    // Escape closes menu
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "User menu" })).toBeNull();

    // Open and sign out
    await user.click(userMenuButton);
    await user.click(screen.getByRole("menuitem", { name: "Sign out" }));

    expect(signOutSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith("/sign-in");
  });

  test("under better-auth mode with multiple orgs, renders org switcher that switches org and reloads", async () => {
    const user = userEvent.setup();
    const reloadSpy = vi.fn();
    window.location.reload = reloadSpy;

    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "better-auth", google: false },
    });
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { email: "multi@example.com" } },
      isPending: false,
    } as never);
    vi.mocked(authClient.useListOrganizations).mockReturnValue({
      data: [
        { id: "org-1", name: "Primary Org" },
        { id: "org-2", name: "Secondary Org" },
      ],
      isPending: false,
    } as never);
    vi.mocked(authClient.useActiveOrganization).mockReturnValue({
      data: { id: "org-1", name: "Primary Org" },
      isPending: false,
    } as never);
    const setActiveSpy = vi
      .spyOn(authClient.organization, "setActive")
      .mockResolvedValue({} as never);

    renderWithRun(<Header />);

    const switcher = await screen.findByRole("combobox", { name: "Switch organization" });
    expect(switcher).toBeTruthy();

    await user.selectOptions(switcher, "org-2");

    expect(setActiveSpy).toHaveBeenCalledWith({ organizationId: "org-2" });
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  test("under better-auth mode, mobile menu includes user email, sign out, and org switcher", async () => {
    const user = userEvent.setup();
    const reloadSpy = vi.fn();
    const assignSpy = vi.fn();
    window.location.reload = reloadSpy;
    window.location.assign = assignSpy;

    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "better-auth", google: false },
    });
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { email: "mobile@example.com" } },
      isPending: false,
    } as never);
    vi.mocked(authClient.useListOrganizations).mockReturnValue({
      data: [
        { id: "org-1", name: "Mobile Org 1" },
        { id: "org-2", name: "Mobile Org 2" },
      ],
      isPending: false,
    } as never);
    vi.mocked(authClient.useActiveOrganization).mockReturnValue({
      data: { id: "org-1", name: "Mobile Org 1" },
      isPending: false,
    } as never);
    const setActiveSpy = vi
      .spyOn(authClient.organization, "setActive")
      .mockResolvedValue({} as never);
    const signOutSpy = vi.spyOn(authClient, "signOut").mockResolvedValue({} as never);

    renderWithRun(<Header />);

    // Open mobile menu
    await user.click(screen.getByLabelText("Open menu"));

    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    expect(within(dialog).getByText("mobile@example.com")).toBeTruthy();

    const mobileSwitcher = within(dialog).getByRole("combobox", { name: "Switch organization" });
    await user.selectOptions(mobileSwitcher, "org-2");
    expect(setActiveSpy).toHaveBeenCalledWith({ organizationId: "org-2" });
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    const signOutBtn = within(dialog).getByRole("button", { name: "Sign out" });
    await user.click(signOutBtn);
    expect(signOutSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith("/sign-in");
  });

  test("user menu renders fallback label when email is undefined", async () => {
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "better-auth", google: false },
    });
    vi.mocked(authClient.useSession).mockReturnValue({
      data: null,
      isPending: false,
    } as never);

    renderWithRun(<Header />);

    const userMenuButton = await screen.findByRole("button", { name: "User menu" });
    expect(userMenuButton.textContent).toContain("Account");
  });

  test("desktop tab navigation triggers guardedPush when editor is dirty", async () => {
    const user = userEvent.setup();
    renderDirty(<Header />);

    await user.click(screen.getByRole("link", { name: "Grid" }));
    expect(screen.getByRole("dialog", { name: "Unsaved edits" })).toBeTruthy();
  });

  test("does not update capabilities if unmounted before promise resolves", async () => {
    // As in the sign-in page's identical test: React 18 drops a late setState on an
    // unmounted component silently, with no dedicated warning to assert on — the
    // honest maximum here is that resolving after unmount raises no React `act`
    // warning and nothing throws.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolveCaps!: (caps: briefsApi.HostCapabilities) => void;
    vi.spyOn(briefsApi, "getCapabilities").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCaps = resolve;
        }),
    );

    const { unmount } = renderWithRun(<Header />);
    unmount();
    await act(async () => {
      resolveCaps({ motion: true, auth: { mode: "better-auth", google: false } });
      await Promise.resolve();
    });

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test("MobileAuthSection renders directly — no portal, no dialog lookup (PT-1b2 item 5)", () => {
    // It used to return null until a `useEffect` found `[role="dialog"][aria-label="Menu"]`
    // in the document and portalled into it. Now it is an ordinary component MobileMenu
    // renders through its `authControls` slot, so it paints synchronously wherever it is
    // mounted — including standalone, with no dialog anywhere in the document.
    render(
      <MobileAuthSection
        email="test@example.com"
        organizations={[]}
        onSwitchOrg={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );
    expect(screen.getByTestId("mobile-auth-controls")).toBeTruthy();
    expect(screen.getByText("test@example.com")).toBeTruthy();
  });

  test("clicking inside user menu does not close it", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "getCapabilities").mockResolvedValue({
      motion: true,
      auth: { mode: "better-auth", google: false },
    });
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { email: "inside@example.com" } },
      isPending: false,
    } as never);

    renderWithRun(<Header />);

    const userMenuButton = await screen.findByRole("button", { name: "User menu" });
    await user.click(userMenuButton);

    const emailHeader = screen.getByText("inside@example.com", { selector: "div" });
    fireEvent.mouseDown(emailHeader);

    expect(screen.getByRole("menu", { name: "User menu" })).toBeTruthy();
  });

  test("desktop tab navigation when clean does not prevent default", async () => {
    const user = userEvent.setup();
    renderWithRun(<Header />);

    await user.click(screen.getByRole("link", { name: "Grid" }));
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
  });

  test("desktop tab navigation ignores modified clicks when dirty", () => {
    renderDirty(<Header />);

    fireEvent.click(screen.getByRole("link", { name: "Grid" }), { metaKey: true });
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
  });

  test("BetterAuthSection falls back to first organization id when activeOrg has none", () => {
    vi.mocked(authClient.useSession).mockReturnValue({
      data: { user: { email: "orgs@example.com" } },
      isPending: false,
    } as never);
    vi.mocked(authClient.useListOrganizations).mockReturnValue({
      data: [
        { id: "fallback-org", name: "Fallback Org" },
        { id: "other-org", name: "Other Org" },
      ],
      isPending: false,
    } as never);
    vi.mocked(authClient.useActiveOrganization).mockReturnValue({
      data: null,
      isPending: false,
    } as never);

    render(<BetterAuthSection />);

    const select = screen.getByRole("combobox", {
      name: "Switch organization",
    }) as HTMLSelectElement;
    expect(select.value).toBe("fallback-org");
  });
});
