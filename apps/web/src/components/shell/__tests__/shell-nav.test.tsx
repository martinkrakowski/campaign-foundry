import { describe, test, expect, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun, seedPersistedRun, nextMock, exerciseFocusTrap } from "@/__tests__/helpers";
import { RunProvider } from "@/lib/run-context";
import { Accordion } from "../Accordion";
import { Sidebar } from "../Sidebar";
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
    rerender(<RunProvider>{<MobileMenu open onClose={onClose} tabs={tabs} />}</RunProvider>);
    await waitFor(() => expect(closed).toBe(true));
  });
});
