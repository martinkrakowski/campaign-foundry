import { describe, test, expect, beforeEach, vi } from "vitest";
import { useEffect } from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { nextMock, mockPipelineApi, json, EMPTY_REPORT } from "@/__tests__/helpers";
import { NO_ORGANISATION_YET_MESSAGE } from "@/lib/auth-errors";
import {
  usePageCampaignParam,
  DELETED_CAMPAIGN_MESSAGE,
  API,
} from "@/lib/run-context";
import { useEditorDirty } from "@/lib/editor-dirty-context";
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

  test("the shell mounts the D185 leave guard, so a dirty editor registers one beforeunload listener", async () => {
    // The guard renders nothing, so the mount cannot be asserted on the DOM.
    // What is observable is its effect: a child that marks the editor dirty
    // produces a registered `beforeunload` listener, and the shell's own mount
    // under `EditorDirtyProvider` is the only thing here that could. Without
    // this, deleting the mount would leave every other leave-guard test green.
    const add = vi.spyOn(window, "addEventListener");
    const MarkDirty = () => {
      const { setDirty } = useEditorDirty();
      useEffect(() => setDirty(true), [setDirty]);
      return null;
    };
    render(
      <ShellLayout>
        <MarkDirty />
      </ShellLayout>,
    );
    await waitFor(() =>
      expect(add.mock.calls.filter(([type]) => type === "beforeunload")).toHaveLength(1),
    );
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

  test("a 404 on the open campaign's result read shows the deleted-campaign notice and leaves for /brief", async () => {
    // PT-9p2: the campaign the page's `?campaign=` resolved is deleted between its
    // meta read and its result read — `campaignKnown` rejected 404. The notice must
    // show (a distinct field from membershipError), and the shell must leave for
    // `/brief`.
    const UUID = "018f6d2a-9c3e-7b4a-8d21-3f9e2a5b6c7d";
    const SLUG = "autumn-launch";
    const storedBrief = {
      id: SLUG,
      template: undefined,
      targetRegion: "DE",
      targetAudience: "a",
      campaignMessage: "m",
      products: [{ id: "p1", name: "P1", primaryColor: "#1473E6", logoPath: "a.png" }],
    };
    nextMock().nav.pathname = "/grid";
    window.history.replaceState(null, "", `/grid?campaign=${UUID}`);

    const WirePageCampaign = () => {
      usePageCampaignParam();
      return null;
    };

    mockPipelineApi({
      result: (url) => {
        if (url === `${API}/campaigns/${UUID}`) {
          return Promise.resolve(
            json({ campaignId: UUID, slug: SLUG, name: "Autumn Launch", type: "social-post", hasVersion: true }),
          );
        }
        if (url.includes("/campaigns/briefs")) {
          return Promise.resolve(
            json({ briefs: [{ file: `${SLUG}.yaml`, campaignId: UUID, brief: storedBrief }] }),
          );
        }
        if (url.includes("/campaigns/jobs")) {
          return Promise.resolve(json({}));
        }
        if (url.includes("/campaigns/result")) {
          // The result read for the OPEN campaign: 404 means deleted.
          if (url.includes(`campaignId=${UUID}`)) {
            return Promise.resolve(json({ error: "Campaign not found" }, 404));
          }
          return Promise.resolve(json(EMPTY_REPORT));
        }
        return Promise.resolve(json(EMPTY_REPORT));
      },
    });

    render(
      <ShellLayout>
        <WirePageCampaign />
        <div>workspace</div>
      </ShellLayout>,
    );

    const notice = await screen.findByRole("alert");
    expect(notice.textContent).toBe(DELETED_CAMPAIGN_MESSAGE);
    expect(nextMock().router.replace).toHaveBeenCalledWith("/brief");
  });
});
