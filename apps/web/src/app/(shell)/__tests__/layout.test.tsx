import { describe, test, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { nextMock } from "@/__tests__/helpers";
import ShellLayout from "../layout";

// ShellLayout provides its own RunProvider, so render it directly.
beforeEach(() => localStorage.setItem("cf:brief-picked", "1"));

describe("ShellLayout", () => {
  test("renders the shell chrome and the orchestrator on the grid route", async () => {
    nextMock().nav.pathname = "/grid";
    render(
      <ShellLayout>
        <div>workspace</div>
      </ShellLayout>,
    );
    expect(screen.getByText("workspace")).toBeTruthy();
    expect(screen.getByText("Pipeline Orchestrator")).toBeTruthy();
  });

  test("toggles the telemetry drawer from the command bar", async () => {
    const user = userEvent.setup();
    nextMock().nav.pathname = "/grid";
    render(
      <ShellLayout>
        <div>workspace</div>
      </ShellLayout>,
    );
    await user.click(screen.getByLabelText("Toggle telemetry logs"));
    await waitFor(() => expect(screen.getByText(/System Telemetry Stream/)).toBeTruthy());
    // Closing the drawer fires the layout's onClose (setTerminalOpen(false)).
    await user.click(screen.getByLabelText("Close telemetry"));
    expect(screen.getByText(/System Telemetry Stream/)).toBeTruthy(); // still mounted (inert), no throw
  });

  test("the header's telemetry button opens the drawer off the grid route", async () => {
    const user = userEvent.setup();
    nextMock().nav.pathname = "/export";
    render(
      <ShellLayout>
        <div>workspace</div>
      </ShellLayout>,
    );
    // The drawer stays mounted for its slide, so openness reads as its aria-hidden
    // state rather than as its presence.
    const drawer = () => screen.getByText(/System Telemetry Stream/).closest("[aria-hidden]");
    expect(drawer()?.getAttribute("aria-hidden")).toBe("true");

    await user.click(screen.getByLabelText("System telemetry"));

    expect(drawer()?.getAttribute("aria-hidden")).toBe("false");
  });

  test("hides the orchestrator off the grid route", () => {
    nextMock().nav.pathname = "/export";
    render(
      <ShellLayout>
        <div>workspace</div>
      </ShellLayout>,
    );
    expect(screen.queryByText("Pipeline Orchestrator")).toBeNull();
  });
});
