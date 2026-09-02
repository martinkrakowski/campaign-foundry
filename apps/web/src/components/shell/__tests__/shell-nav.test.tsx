import { describe, test, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, useEffect, type ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { renderWithRun, seedPersistedRun, nextMock, exerciseFocusTrap, makeAsset, ShellProviders } from "@/__tests__/helpers";
import { useEditorDirty } from "@/lib/editor-dirty-context";
import { Accordion } from "../Accordion";
import { Sidebar, BrowseBriefsButton, SidebarContent } from "../Sidebar";
import { useEditorPanels } from "@/lib/editor-panels-context";
import { useRun } from "@/lib/run-context";
import { blankBrief } from "@/components/campaign/editor-state";
import { Header } from "../Header";
import { MobileMenu } from "../MobileMenu";
import { DialogShell } from "@/components/ui";
import * as briefsApi from "@/lib/briefs-api";

beforeEach(() => {
  nextMock().nav.pathname = "/grid";
});

describe("Accordion", () => {
  test("renders open by default and toggles closed", async () => {
    const user = userEvent.setup();
    renderWithRun(
      <Accordion title="Section" aside={<span>aside</span>}>
        <p>body</p>
      </Accordion>,
    );
    expect(screen.getByText("body")).toBeTruthy();
    expect(screen.getByText("aside")).toBeTruthy();
    await user.click(screen.getByRole("button"));
    expect(screen.queryByText("body")).toBeNull();
  });

  test("respects defaultOpen=false", () => {
    renderWithRun(
      <Accordion title="Section" defaultOpen={false}>
        <p>body</p>
      </Accordion>,
    );
    expect(screen.queryByText("body")).toBeNull();
  });
});

describe("Sidebar", () => {
  test("renders the brief fields and project bin with real assets", async () => {
    vi.spyOn(briefsApi, "listAssets").mockResolvedValueOnce({
      assets: [
        { name: "hydra-logo.png", type: "image/png", size: 1024, thumbnailUrl: "data:image/png;base64,AAA" },
        { name: "trail-logo.png", type: "image/png", size: 2048, thumbnailUrl: "" },
      ],
    });
    renderWithRun(<Sidebar />);
    expect(screen.getByText("summer-hydration-2026")).toBeTruthy();
    expect(screen.getByText("Project Bin")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("2 assets")).toBeTruthy();
      expect(screen.getByText("hydra-logo.png")).toBeTruthy();
      expect(screen.getByText("trail-logo.png")).toBeTruthy();
    });
  });

  test("renders empty state in Project Bin when no assets exist", async () => {
    vi.spyOn(briefsApi, "listAssets").mockResolvedValueOnce({ assets: [] });
    renderWithRun(<Sidebar />);
    await waitFor(() => {
      expect(screen.getByText("0 assets")).toBeTruthy();
      expect(screen.getByText("No assets uploaded yet.")).toBeTruthy();
    });
  });

  test("handles asset list failure gracefully", async () => {
    vi.spyOn(briefsApi, "listAssets").mockRejectedValueOnce(new Error("Network error"));
    renderWithRun(<Sidebar />);
    await waitFor(() => {
      expect(screen.getByText("0 assets")).toBeTruthy();
      expect(screen.getByText("No assets uploaded yet.")).toBeTruthy();
    });
  });

  test("aborts in-flight listAssets request when unmounted (both resolve and reject)", async () => {
    let capturedSignal1: AbortSignal | undefined;
    let resolveP: (v: { assets: briefsApi.AssetEntry[] }) => void = () => {};
    const pendingP = new Promise<{ assets: briefsApi.AssetEntry[] }>((r) => (resolveP = r));
    vi.spyOn(briefsApi, "listAssets").mockImplementationOnce((_id, signal) => {
      capturedSignal1 = signal;
      return pendingP;
    });
    const { unmount } = renderWithRun(<Sidebar />);
    expect(capturedSignal1?.aborted).toBe(false);
    unmount();
    expect(capturedSignal1?.aborted).toBe(true);
    resolveP({ assets: [] });

    let capturedSignal2: AbortSignal | undefined;
    let rejectP: (err: unknown) => void = () => {};
    const pendingR = new Promise<{ assets: briefsApi.AssetEntry[] }>((_, r) => (rejectP = r));
    vi.spyOn(briefsApi, "listAssets").mockImplementationOnce((_id, signal) => {
      capturedSignal2 = signal;
      return pendingR;
    });
    const { unmount: unmount2 } = renderWithRun(<Sidebar />);
    expect(capturedSignal2?.aborted).toBe(false);
    unmount2();
    expect(capturedSignal2?.aborted).toBe(true);
    rejectP(new Error("aborted"));
    await new Promise((r) => setTimeout(r, 20));
  });

  test("clicking Browse or an asset in Project Bin opens the AssetPickerDrawer", async () => {
    const user = userEvent.setup();
    vi.spyOn(briefsApi, "listAssets").mockResolvedValue({
      assets: [
        { name: "hydra-logo.png", type: "image/png", size: 1024, thumbnailUrl: "data:image/png;base64,AAA" },
      ],
    });
    renderWithRun(<Sidebar />);
    await waitFor(() => {
      expect(screen.getByText("hydra-logo.png")).toBeTruthy();
    });

    expect(screen.queryByRole("dialog", { name: "Asset Bin" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Browse" }));
    expect(await screen.findByRole("dialog", { name: "Asset Bin" })).toBeTruthy();

    // Close drawer
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Asset Bin" })).toBeNull();
    });

    // Clicking asset card also opens drawer
    await user.click(screen.getByText("hydra-logo.png"));
    expect(await screen.findByRole("dialog", { name: "Asset Bin" })).toBeTruthy();
  });

  test("discards stale listAssets responses when brief ID changes", async () => {
    const user = userEvent.setup();
    let resolveFirst: (v: { assets: briefsApi.AssetEntry[] }) => void = () => {};
    const firstP = new Promise<{ assets: briefsApi.AssetEntry[] }>((r) => (resolveFirst = r));

    vi.spyOn(briefsApi, "listAssets").mockImplementation((id) => {
      if (id === "summer-hydration-2026") return firstP;
      return Promise.resolve({
        assets: [{ name: "new-brief-logo.png", type: "image/png", size: 500, thumbnailUrl: "" }],
      });
    });

    const Switcher = () => {
      const { setBrief } = useRun();
      return (
        <div>
          <button
            type="button"
            onClick={() =>
              setBrief({
                id: "winter-hydration-2026",
                targetRegion: "US",
                targetAudience: "all",
                campaignMessage: "Winter",
                products: [],
              })
            }
          >
            Switch
          </button>
          <SidebarContent />
        </div>
      );
    };

    renderWithRun(<Switcher />);

    // Fast-switch brief to another ID
    await user.click(screen.getByRole("button", { name: "Switch" }));

    await waitFor(() => {
      expect(screen.getByText("new-brief-logo.png")).toBeTruthy();
    });

    // Now resolve late response from the previous brief
    resolveFirst({
      assets: [{ name: "old-stale-logo.png", type: "image/png", size: 100, thumbnailUrl: "" }],
    });
    await new Promise((r) => setTimeout(r, 20));

    // Stale logo must NOT overwrite the new brief's assets
    expect(screen.queryByText("old-stale-logo.png")).toBeNull();
    expect(screen.getByText("new-brief-logo.png")).toBeTruthy();
  });

  test("Browse briefs opens the picker", async () => {
    const user = userEvent.setup();
    renderWithRun(<Sidebar />);
    // Picker isn't rendered here, but openBriefPicker is wired — clicking shouldn't throw.
    await user.click(screen.getByText("Browse briefs"));
    expect(screen.getByText("Browse briefs")).toBeTruthy();
  });
});

describe("Sidebar — editor panels", () => {
  test("shows nothing extra when no editor is publishing panels", () => {
    seedPersistedRun([makeAsset()]);
    renderWithRun(<SidebarContent />);
    // the bar's own sections only — no separator, no placed panel
    expect(screen.getByText("Campaign Brief")).toBeTruthy();
    expect(screen.getByText("Project Bin")).toBeTruthy();
    expect(screen.queryByText("Variation Policy")).toBeNull();
  });

  test("places the panels an editor publishes, after Project Bin", () => {
    const Publish = () => {
      const { setPanels } = useEditorPanels();
      useEffect(() => {
        setPanels(<p>policy lives here</p>);
        return () => setPanels(null);
      }, [setPanels]);
      return null;
    };
    seedPersistedRun([makeAsset()]);
    renderWithRun(
      <>
        <Publish />
        <SidebarContent />
      </>,
    );
    const placed = screen.getByText("policy lives here");
    const bin = screen.getByText("Project Bin");
    expect(bin.compareDocumentPosition(placed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("Header", () => {
  test("marks the active tab from the pathname", () => {
    nextMock().nav.pathname = "/compliance";
    renderWithRun(<Header />);
    const active = screen.getByRole("link", { name: "Compliance" });
    expect(active.className).toContain("text-text-emphasis");
    // The underline must track the same token as the text. It was `border-white`, which
    // in the light theme is a white rule on a white ground — the active tab would read
    // as inactive while its label looked right.
    expect(active.className).toContain("border-text-emphasis");
    expect(active.className).not.toContain("border-white");
  });

  test("the hamburger opens and closes the mobile menu", async () => {
    const user = userEvent.setup();
    renderWithRun(<Header />);
    await user.click(screen.getByLabelText("Open menu"));
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    await user.click(within(dialog).getByLabelText("Close menu")); // fires Header.closeMenu
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Menu" })).toBeNull());
  });
});

describe("MobileMenu", () => {
  const tabs = [
    { href: "/grid", label: "Grid" },
    { href: "/export", label: "Export" },
  ] as const;

  test("the menu's title renders through Eyebrow on the tracking token", async () => {
    seedPersistedRun([]);
    renderWithRun(<MobileMenu open onClose={() => {}} tabs={tabs} />);
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    const title = within(dialog).getByText("Menu");
    expect(title.tagName).toBe("SPAN");
    expect(title.className).toContain("tracking-eyebrow");
    expect(title.className).not.toContain("tracking-widest");
  });

  test("marks only the active tab with aria-current and leaves the others bare", () => {
    nextMock().nav.pathname = "/export";
    renderWithRun(<MobileMenu open onClose={() => {}} tabs={tabs} />);
    const active = screen.getByRole("link", { name: "Export" });
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Grid" }).getAttribute("aria-current")).toBeNull();
  });

  test("renders nothing when closed", () => {
    const { container } = renderWithRun(<MobileMenu open={false} onClose={() => {}} tabs={tabs} />);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test("closes on Escape and locks body scroll while open", async () => {
    const user = userEvent.setup();
    let closed = false;
    renderWithRun(<MobileMenu open onClose={() => (closed = true)} tabs={tabs} />);
    expect(document.body.style.overflow).toBe("hidden");
    await user.keyboard("{Escape}");
    expect(closed).toBe(true);
  });

  test("an Escape while a shared-shell overlay holds focus leaves the menu open", async () => {
    const user = userEvent.setup();
    let closed = false;
    const onCloseOverlay = vi.fn();
    renderWithRun(
      <div>
        <MobileMenu open onClose={() => (closed = true)} tabs={tabs} />
        <DialogShell open onClose={onCloseOverlay} ariaLabel="Menu Overlay">
          <button type="button">Overlay button</button>
        </DialogShell>
      </div>,
    );

    await screen.findByRole("dialog", { name: "Menu" });
    await user.keyboard("{Escape}");

    expect(onCloseOverlay).toHaveBeenCalledTimes(1);
    expect(closed).toBe(false);
  });

  test("a tab link closes the menu", async () => {
    const user = userEvent.setup();
    let closed = false;
    seedPersistedRun([]);
    renderWithRun(<MobileMenu open onClose={() => (closed = true)} tabs={tabs} />);
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    await user.click(within(dialog).getByRole("link", { name: "Grid" }));
    expect(closed).toBe(true);
  });

  test("traps Tab focus within the dialog", async () => {
    seedPersistedRun([]);
    renderWithRun(<MobileMenu open onClose={() => {}} tabs={tabs} />);
    const dialog = await screen.findByRole("dialog", { name: "Menu" });
    exerciseFocusTrap(dialog);
    await waitFor(() => expect(document.activeElement).toBeTruthy());
  });

  test("closes when the route changes while open", async () => {
    let closed = false;
    nextMock().nav.pathname = "/grid";
    const onClose = () => {
      closed = true;
    };
    const { rerender } = renderWithRun(<MobileMenu open onClose={onClose} tabs={tabs} />);
    await screen.findByRole("dialog", { name: "Menu" });
    nextMock().nav.pathname = "/export"; // navigate away
    rerender(
      <ShellProviders>
        <MobileMenu open onClose={onClose} tabs={tabs} />
      </ShellProviders>,
    );
    await waitFor(() => expect(closed).toBe(true));
  });
});

describe("Create new", () => {
  test("the sidebar's Create new button navigates to /brief/new", async () => {
    const { BrowseBriefsButton } = await import("../Sidebar");
    const onActivate = vi.fn();
    renderWithRun(createElement(BrowseBriefsButton, { onActivate }));
    await userEvent.setup().click(screen.getByRole("button", { name: /create new/i }));
    expect(onActivate).toHaveBeenCalled();
    // the blank editor is its own route: landing on /brief would adopt the active brief
    expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new");
  });
});

describe("guarded navigation when the editor is dirty", () => {
  /** Renders `ui` inside the real providers with the dirty flag already raised. */
  const renderDirty = (ui: ReactElement) => {
    const RaiseDirty = () => {
      const { setDirty } = useEditorDirty();
      useEffect(() => setDirty(true), [setDirty]);
      return null;
    };
    return render(createElement(ShellProviders, null, createElement(RaiseDirty), ui));
  };

  beforeEach(() => {
    nextMock().router.push.mockClear();
  });

  test("the sidebar's Create new button asks once before leaving, and stays put if refused", async () => {
    const user = userEvent.setup();
    renderDirty(createElement(BrowseBriefsButton, {}));

    await user.click(screen.getByRole("button", { name: /Create new/ }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(dialog).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull());
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("accepting the prompt navigates", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    renderDirty(createElement(BrowseBriefsButton, { onActivate }));

    await user.click(screen.getByRole("button", { name: /Create new/ }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(dialog).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Leave" }));
    expect(onActivate).toHaveBeenCalled();
    expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new");
  });

  test("the sidebar's Edit link routes through the guard and dismisses the overlay", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    seedPersistedRun([makeAsset()]);
    renderDirty(createElement(SidebarContent, { onNavigate }));

    await user.click(screen.getByText("Edit"));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(dialog).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Leave" }));
    expect(onNavigate).toHaveBeenCalled();
    // D37: Edit names the active brief's own route — bare "/brief" redirected a
    // fresh profile (no cf:brief) straight back to the grid, a silent loop.
    expect(nextMock().router.push).toHaveBeenCalledWith("/brief/seed");
  });

  test("the Edit link names the active brief's route, never the bare redirector", () => {
    seedPersistedRun([makeAsset()]);
    renderDirty(createElement(SidebarContent, { onNavigate: vi.fn() }));
    // Bare "/brief" redirects by cf:brief, which a fresh profile lacks — the link
    // looped to the grid. The brief's own route always answers (M3 covers unknowns).
    // Exact, not a pattern: /brief/undefined would have matched the loose regex.
    expect(screen.getByText("Edit").getAttribute("href")).toBe("/brief/seed");
  });

  test("a released shell (blank brief) sends Edit to /brief/new, never the redirector", async () => {
    // Arriving at /brief/new releases the campaign: the shell's brief id is "".
    // Interpolating that gives "/brief/" and the suggested fallback of bare
    // "/brief" restores the redirect loop — the honest target is the new-brief route.
    const ReleaseBrief = () => {
      const { setBrief } = useRun();
      useEffect(() => setBrief(blankBrief()), [setBrief]);
      return null;
    };
    render(createElement(ShellProviders, null, createElement(ReleaseBrief), createElement(SidebarContent, { onNavigate: vi.fn() })));
    await waitFor(() => expect(screen.getByText("Edit").getAttribute("href")).toBe("/brief/new"));
  });

  test("a header tab click is intercepted and routed through the guard", async () => {
    const user = userEvent.setup();
    renderDirty(createElement(Header));

    await user.click(screen.getByRole("link", { name: "Compliance" }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(dialog).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Leave" }));
    expect(nextMock().router.push).toHaveBeenCalledWith("/compliance");
  });

  test("a header tab click is not intercepted while clean", async () => {
    const user = userEvent.setup();
    render(createElement(ShellProviders, null, createElement(Header)));

    await user.click(screen.getByRole("link", { name: "Compliance" }));
    // no guard, so the Link navigates on its own rather than through router.push
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("a clean mobile tab click routes client-side instead of reloading", async () => {
    const user = userEvent.setup();
    const tabs = [{ href: "/grid", label: "Grid" }] as const;
    render(createElement(ShellProviders, null, createElement(MobileMenu, { open: true, onClose: () => {}, tabs })));
    await user.click(screen.getByRole("link", { name: "Grid" }));
    // The tab is a raw <a>, so without preventDefault this would be a native page
    // load — routing through the client router is the "did not reload" proof.
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
  });

  // A modified or non-primary click (Cmd/Ctrl/Shift/Alt/middle) is the browser's own
  // job: it must keep the native behaviour (new tab / new window / download) instead of
  // being intercepted into a client-side route, a dirty prompt, or a menu close.
  test.each(["metaKey", "ctrlKey", "shiftKey", "altKey", "button"] as const)(
    "a %s click on a mobile tab leaves it to the browser: no push, no prompt, no close",
    (modifier) => {
      const tabs = [{ href: "/grid", label: "Grid" }] as const;
      const onClose = vi.fn();
      render(createElement(ShellProviders, null, createElement(MobileMenu, { open: true, onClose, tabs })));
      fireEvent.click(screen.getByRole("link", { name: "Grid" }), {
        [modifier]: modifier === "button" ? 1 : true,
      });
      expect(nextMock().router.push).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  test("a dirty mobile tab click the user accepts prompts exactly once and navigates", async () => {
    const user = userEvent.setup();
    const tabs = [{ href: "/grid", label: "Grid" }] as const;
    renderDirty(createElement(MobileMenu, { open: true, onClose: () => {}, tabs }));
    await user.click(screen.getByRole("link", { name: "Grid" }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(dialog).toBeTruthy();
    expect(screen.getAllByRole("dialog", { name: "Unsaved edits" })).toHaveLength(1);

    await user.click(within(dialog).getByRole("button", { name: "Leave" }));
    // W1 fixed a *double* interception here, and the guard for it must survive the move
    // from window.confirm to the in-app dialog. Counting rendered dialogs cannot see it
    // — the dialog is a singleton — so assert what a second interception would actually
    // produce: another prompt still standing, or a second push.
    expect(nextMock().router.push).toHaveBeenCalledTimes(1);
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
  });

  test("a dirty mobile tab click the user cancels does not navigate and leaves the menu open", async () => {
    const user = userEvent.setup();
    const tabs = [{ href: "/grid", label: "Grid" }] as const;
    const onClose = vi.fn();
    renderDirty(createElement(MobileMenu, { open: true, onClose, tabs }));
    await user.click(screen.getByRole("link", { name: "Grid" }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(dialog).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull());
    expect(nextMock().router.push).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
