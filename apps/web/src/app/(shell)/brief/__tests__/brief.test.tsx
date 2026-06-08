import { describe, test, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun, nextMock } from "@/__tests__/helpers";
import BriefPage from "../page";

beforeEach(() => localStorage.setItem("cf:brief-picked", "1"));

describe("BriefPage", () => {
  test("renders the current brief's fields", () => {
    renderWithRun(<BriefPage />);
    expect(screen.getByDisplayValue("summer-hydration-2026")).toBeTruthy();
    expect(screen.getByText(/Products \(2\)/)).toBeTruthy();
  });

  test("edits a field", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
    const region = screen.getByDisplayValue("DE");
    await user.clear(region);
    await user.type(region, "US");
    expect(screen.getByDisplayValue("US")).toBeTruthy();
  });

  test("adds and removes a product", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
    await user.click(screen.getByText("Add product"));
    expect(screen.getByText(/Products \(3\)/)).toBeTruthy();
    await user.click(screen.getAllByText("Remove")[0]);
    expect(screen.getByText(/Products \(2\)/)).toBeTruthy();
  });

  test("flags an invalid id and disables saving", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
    const id = screen.getByDisplayValue("summer-hydration-2026");
    await user.clear(id);
    await user.type(id, "Bad Id");
    expect(screen.getByText(/Lowercase letters, digits and hyphens/)).toBeTruthy();
    expect((screen.getByText("Save brief") as HTMLButtonElement).disabled).toBe(true);
  });

  test("edits every field type and clears the localized message on save", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
    for (const [current, next] of [
      ["Urban outdoor enthusiasts, 25-40", "New audience"],
      ["Stay wild. Stay hydrated.", "New message"],
      ["Hydra Bottle", "Renamed"],
      ["hydra-bottle", "renamed-id"],
      ["#1473E6", "#000000"],
      ["assets/inputs/hydra-logo.png", "assets/inputs/x.png"],
    ] as const) {
      const field = screen.getByDisplayValue(current);
      await user.clear(field);
      await user.type(field, next);
    }
    const localized = screen.getByDisplayValue("Bleib wild. Bleib hydriert.");
    await user.clear(localized); // empty → saved as undefined
    await user.click(screen.getByText("Save brief"));
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
  });

  test("saves a valid brief and navigates to the grid", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
    await user.click(screen.getByText("Save brief"));
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
  });

  test("cancel navigates back", async () => {
    const user = userEvent.setup();
    renderWithRun(<BriefPage />);
    await user.click(screen.getByText("Cancel"));
    expect(nextMock().router.back).toHaveBeenCalled();
  });
});
