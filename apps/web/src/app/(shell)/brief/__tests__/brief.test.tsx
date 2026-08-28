import { describe, test, expect, beforeEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun } from "@/__tests__/helpers";
import BriefPage from "../page";
import { useEditorPanels } from "@/lib/editor-panels-context";

/** Places the sections the page publishes to the left bar (the variation policy). */
const BarPanels = () => useEditorPanels().panels ?? null;
/** The page plus the bar panels it publishes, as a user would see them together. */
const Editor = () => (
  <>
    <BriefPage />
    <BarPanels />
  </>
);

/** Save actions live behind the "Save" menu now: open it, then pick the item. */
const saveVia = async (user: ReturnType<typeof userEvent.setup>, item: "Save & apply" | "Save as") => {
  await user.click(screen.getByRole("button", { name: /^Save$/ }));
  await user.click(await screen.findByRole("menuitem", { name: new RegExp(item.replace("&", "&")) }));
};

beforeEach(() => {
  localStorage.setItem("cf:brief-picked", "1");
  // Mock confirm to return true
  globalThis.confirm = vi.fn(() => true);
});

describe("BriefPage E1 Features", () => {
  test("renders the editor with status chip", () => {
    renderWithRun(<Editor />);
    expect(screen.getByText("Draft not applied")).toBeTruthy();
  });

  test("has BriefSelector component", () => {
    renderWithRun(<Editor />);
    expect(screen.getByRole("button", { name: /New brief/ })).toBeTruthy();
  });

  test("has mode toggle buttons", () => {
    renderWithRun(<Editor />);
    expect(screen.getByText("Classic")).toBeTruthy();
    expect(screen.getByText("Randomized")).toBeTruthy();
  });

  test("has action bar buttons — Discard, Apply and Save, with YAML split behind the overflow", async () => {
    const user = userEvent.setup();
    renderWithRun(<Editor />);
    const bar = screen.getByTestId("action-bar");
    // the error strip's chips sit in the bar too; the action buttons are the rest
    // the primary row only: error-strip chips are pills, and the ⋯ overflow's contents
    // are behind a <details> — both are in the bar's DOM but not in the row of verbs.
    const labels = Array.from(bar.querySelectorAll("button"))
      .filter((b) => !b.classList.contains("rounded-full") && !b.closest("details"))
      .map((b) => b.textContent?.trim());
    // D3: the bar carries the status sentence and the three verbs; the YAML split
    // moved out of the primary row into the ⋯ overflow so the sentence has room.
    expect(labels).toEqual(expect.arrayContaining(["Discard", "Save", "Apply to run"]));
    expect(labels).not.toContain("YAML split on");
    // a blank draft is invalid, so Save (and Apply) are held back; the menu's own
    // behaviour is covered in save-menu.test.tsx
    expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Apply to run").closest("button") as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("Save as... opens dialog", async () => {
    const user = userEvent.setup();
    renderWithRun(<Editor />);
    // Save as… is disabled while the draft has validation errors, so fill it in first.
    await user.type(screen.getByLabelText("Brief ID"), "fresh");
    await user.type(screen.getByLabelText("Target Region"), "DE");
    await user.type(screen.getByLabelText("Target Audience"), "a");
    await user.type(screen.getByLabelText("Campaign Message"), "Hi");
    const names = screen.getAllByLabelText("Name");
    await user.type(names[0], "A");
    await user.type(names[1], "B");
    const logos = screen
      .getAllByLabelText("Logo Path")
      .filter((el) => el.tagName === "INPUT" && el.getAttribute("type") !== "file");
    await user.type(logos[0], "a.png");
    await user.type(logos[1], "b.png");
    // Once the dialog is open, "Save as..." matches both the action-bar button and
    // the dialog heading — query by role so each assertion names the one it means.
    await saveVia(user, "Save as");
    expect(screen.getByRole("dialog", { name: /Save as/ })).toBeTruthy();
    expect(screen.getByLabelText("New brief id")).toBeTruthy();
  });

  test("YAML split toggle", async () => {
    const user = userEvent.setup();
    renderWithRun(<Editor />);
    await user.click(screen.getByText("YAML split on"));
    expect(screen.getByText("YAML split off")).toBeTruthy();
  });
});
