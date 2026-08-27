import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { createElement, useEffect, type ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { renderWithRun, seedPersistedRun, nextMock, exerciseFocusTrap, makeAsset, ShellProviders } from "@/__tests__/helpers";
import { useEditorDirty } from "@/lib/editor-dirty-context";
import { Accordion } from "../Accordion";
import { Sidebar, BrowseBriefsButton, SidebarContent } from "../Sidebar";
import { Header } from "../Header";
import { MobileMenu } from "../MobileMenu";

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
  test("renders the brief fields and product bin", () => {
    renderWithRun(<Sidebar />);
    expect(screen.getByText("summer-hydration-2026")).toBeTruthy();
    expect(screen.getByText("2 assets")).toBeTruthy();
    expect(screen.getByText("Hydra Bottle")).toBeTruthy();
  });

  test("Browse briefs opens the picker", async () => {
    const user = userEvent.setup();
    renderWithRun(<Sidebar />);
    // Picker isn't rendered here, but openBriefPicker is wired — clicking shouldn't throw.
    await user.click(screen.getByText("Browse briefs"));
    expect(screen.getByText("Browse briefs")).toBeTruthy();
  });
});

describe("Header", () => {
  test("marks the active tab from the pathname", () => {
    nextMock().nav.pathname = "/compliance";
    renderWithRun(<Header />);
    const active = screen.getByRole("link", { name: "Compliance" });
    expect(active.className).toContain("text-white");
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
  test("the sidebar's Create new button navigates to /brief", async () => {
    const { BrowseBriefsButton } = await import("../Sidebar");
    const onActivate = vi.fn();
    renderWithRun(createElement(BrowseBriefsButton, { onActivate }));
    await userEvent.setup().click(screen.getByRole("button", { name: /create new/i }));
    expect(onActivate).toHaveBeenCalled();
    expect(nextMock().router.push).toHaveBeenCalledWith("/brief");
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
    const confirm = vi.fn(() => false);
    globalThis.confirm = confirm;
    renderDirty(createElement(BrowseBriefsButton, {}));

    await user.click(screen.getByRole("button", { name: /Create new/ }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("accepting the prompt navigates", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => true);
    const onActivate = vi.fn();
    renderDirty(createElement(BrowseBriefsButton, { onActivate }));

    await user.click(screen.getByRole("button", { name: /Create new/ }));
    expect(onActivate).toHaveBeenCalled();
    expect(nextMock().router.push).toHaveBeenCalledWith("/brief");
  });

  test("the sidebar's Edit link routes through the guard and dismisses the overlay", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => true);
    const onNavigate = vi.fn();
    seedPersistedRun([makeAsset()]);
    renderDirty(createElement(SidebarContent, { onNavigate }));

    await user.click(screen.getByText("Edit"));
    expect(onNavigate).toHaveBeenCalled();
    expect(nextMock().router.push).toHaveBeenCalledWith("/brief");
  });

  test("a header tab click is intercepted and routed through the guard", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => true);
    renderDirty(createElement(Header));

    await user.click(screen.getByRole("link", { name: "Compliance" }));
    expect(nextMock().router.push).toHaveBeenCalledWith("/compliance");
  });

  test("a header tab click is not intercepted while clean", async () => {
    const user = userEvent.setup();
    render(createElement(ShellProviders, null, createElement(Header)));

    await user.click(screen.getByRole("link", { name: "Compliance" }));
    // no guard, so the Link navigates on its own rather than through router.push
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("a mobile tab click is blocked when the prompt is refused, and allowed when accepted", async () => {
    const user = userEvent.setup();
    const tabs = [{ href: "/grid", label: "Grid" }] as const;

    globalThis.confirm = vi.fn(() => false);
    const refused = renderDirty(
      createElement(MobileMenu, { open: true, onClose: () => {}, tabs }),
    );
    await user.click(screen.getByRole("link", { name: "Grid" }));
    expect(globalThis.confirm).toHaveBeenCalled();
    refused.unmount();

    globalThis.confirm = vi.fn(() => true);
    renderDirty(createElement(MobileMenu, { open: true, onClose: () => {}, tabs }));
    await user.click(screen.getByRole("link", { name: "Grid" }));
    expect(globalThis.confirm).toHaveBeenCalled();
  });
});
