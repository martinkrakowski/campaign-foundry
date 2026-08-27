import { describe, test, expect, beforeEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun } from "@/__tests__/helpers";
import BriefPage from "../page";

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
    renderWithRun(<BriefPage />);
    expect(screen.getByText("Draft not applied")).toBeTruthy();
  });

  test("has BriefSelector component", () => {
    renderWithRun(<BriefPage />);
    expect(screen.getByRole("button", { name: /New brief/ })).toBeTruthy();
  });

  test("has mode toggle buttons", () => {
    renderWithRun(<BriefPage />);
    expect(screen.getByText("Classic")).toBeTruthy();
    expect(screen.getByText("Randomized")).toBeTruthy();
  });

  test("has action bar buttons — YAML split on the left, then Discard, Save, Apply on the right", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
    const bar = screen.getByTestId("action-bar");
    // the error strip's chips sit in the bar too; the action buttons are the rest
    const labels = Array.from(bar.querySelectorAll("button"))
      .filter((b) => !b.classList.contains("rounded-full"))
      .map((b) => b.textContent?.trim());
    expect(labels).toEqual(["YAML split on", "Discard", "Save", "Apply to run"]);
    // a blank draft is invalid, so Save (and Apply) are held back; the menu's own
    // behaviour is covered in save-menu.test.tsx
    expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Apply to run").closest("button") as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("Save as... opens dialog", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
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
    renderWithRun(<BriefPage />);
    await user.click(screen.getByText("YAML split on"));
    expect(screen.getByText("YAML split off")).toBeTruthy();
  });
});
