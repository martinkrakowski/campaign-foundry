import { describe, test, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun, seedPersistedRun, makeAsset, exerciseFocusTrap } from "@/__tests__/helpers";
import { CommandBar } from "../CommandBar";

beforeEach(() => localStorage.setItem("cf:brief-picked", "1"));

describe("CommandBar", () => {
  test("toggles the telemetry drawer", async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderWithRun(<CommandBar onToggleTelemetry={onToggle} />);
    await user.click(screen.getByLabelText("Toggle telemetry logs"));
    expect(onToggle).toHaveBeenCalled();
  });

  test("confirms and runs the full pipeline", async () => {
    const user = userEvent.setup();
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    expect(screen.getByText(/Standing by/)).toBeTruthy();
    await user.click(screen.getByText(/Execute/));
    const dialog = await screen.findByRole("dialog", { name: "Confirm pipeline action" });
    expect(within(dialog).getByText(/every product × aspect ratio × treatment/)).toBeTruthy();
    await user.click(within(dialog).getByText("Generate"));
    await waitFor(() => expect(screen.getByText(/Execution complete|Standing by|Orchestrating/)).toBeTruthy());
  });

  test("cancel closes the confirm dialog without running", async () => {
    const user = userEvent.setup();
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    await user.click(screen.getByText(/Execute/));
    const dialog = await screen.findByRole("dialog");
    exerciseFocusTrap(dialog);
    await user.keyboard("{Escape}"); // Escape closes the confirm dialog
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByText(/Execute/));
    await screen.findByRole("dialog");
    await user.click(screen.getByText("Cancel"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("shows a regenerate action once creatives are rejected", async () => {
    const user = userEvent.setup();
    localStorage.setItem("cf:decisions", JSON.stringify({ "alpha/1:1/default": "rejected" }));
    seedPersistedRun([makeAsset(), makeAsset({ productId: "beta", outputPath: "beta/1x1.png" })]);
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    const regen = await screen.findByText(/Regenerate/);
    await user.click(regen);
    const dialog = await screen.findByRole("dialog", { name: "Confirm pipeline action" });
    expect(within(dialog).getByText(/1 rejected/)).toBeTruthy();
    await user.click(within(dialog).getByText("Regenerate rejected"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
