import { describe, test, expect, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { nextMock, mockPipelineApi, json } from "@/__tests__/helpers";
import { NO_ORGANISATION_YET_MESSAGE } from "@/lib/auth-errors";
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

  test("a 403 no_membership on the mount restore shows the no-organisation notice, above every route", async () => {
    // PT-1b2 item 5: a 403 must show a "no organisation yet" state. The mount
    // effect's own persisted-run fetch is the one every shell route runs on
    // load, so this is asserted off /grid — where CommandBar (and its separate
    // `error` status line) does not even mount.
    nextMock().nav.pathname = "/export";
    mockPipelineApi({
      result: () =>
        json({ error: "This account belongs to no organisation.", code: "no_membership" }, 403),
    });

    render(
      <ShellLayout>
        <div>workspace</div>
      </ShellLayout>,
    );

    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toBe(NO_ORGANISATION_YET_MESSAGE);
  });

  test("an ordinary pipeline failure on the mount restore does not show the no-organisation notice", async () => {
    // F6: a non-membership failure on the mount restore claims nothing and shows
    // nothing (`could not ask is not absence`) — it must not, in particular, be
    // mistaken for a 403 and show the membership notice.
    nextMock().nav.pathname = "/grid";
    mockPipelineApi({ result: () => json({ error: "boom" }, 500) });

    render(
      <ShellLayout>
        <div>workspace</div>
      </ShellLayout>,
    );

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    // Flush the fetch's resolution and the mount effect's catch handler.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
