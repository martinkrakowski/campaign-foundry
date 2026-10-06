import { describe, test, expect, beforeEach, vi } from "vitest";
import { CreateCampaignProvider } from "@/lib/create-campaign-context";
import { screen, waitFor, within, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  EMPTY_REPORT,
  json,
  mockPipelineApi,
  nextMock,
  renderWithRun as renderWithShell,
  exerciseFocusTrap,
} from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
import { NO_ORGANISATION_YET_MESSAGE } from "@/lib/auth-errors";
import * as messages from "@/components/campaign/messages";
import { BriefPicker } from "../BriefPicker";
import { CreateCampaignDialog } from "../CreateCampaignDialog";

/**
 * W1: the picker and the create dialog are shell overlays mounted side by side in
 * the layout; the suite mounts both so the create gesture is exercisable end to end.
 */
const renderWithRun = (ui: React.ReactElement) =>
  renderWithShell(
    <CreateCampaignProvider>
      {ui}
      <CreateCampaignDialog />
    </CreateCampaignProvider>,
  );

beforeEach(() => localStorage.removeItem("cf:brief-picked"));

const UUID = "11111111-2222-4333-8444-555555555555";
const demo = {
  file: "demo.yaml",
  campaignId: UUID,
  brief: { id: "demo", targetRegion: "DE", products: [{ id: "a" }] },
};
const other = {
  file: "other.yaml",
  brief: { id: "other", targetRegion: "DE", products: [{ id: "a" }] },
};
// brief.id equals DEFAULT_BRIEF.id, so `isCurrent` is true with no seeding.
const open = {
  file: "summer.yaml",
  campaignId: "open-1",
  brief: { id: "summer-hydration-2026", targetRegion: "DE", products: [{ id: "a" }] },
};
const fresh = {
  file: "fresh.yaml",
  brief: { id: "fresh", targetRegion: "DE", products: [{ id: "a" }] },
};

interface Route {
  briefs?: unknown[];
  afterDelete?: unknown[];
  failReload?: boolean;
  del?: () => Response | Promise<Response>;
  /** Returned for each list request after the first, by 1-based index; may be a deferred promise. */
  listAfterFirst?: (index: number) => Response | Promise<Response>;
}
const deletes: string[] = [];
const route = (r: Route = {}) => {
  let lists = 0;
  deletes.length = 0;
  mockPipelineApi({
    result: (url, req) => {
      if (req?.method === "DELETE") {
        deletes.push(url);
        return r.del ? r.del() : json({ deletionId: "d1" }, 202);
      }
      if (url.includes("/campaigns/briefs")) {
        lists += 1;
        if (lists > 1 && r.failReload) return json({ error: "fail" }, 500);
        if (lists > 1 && r.listAfterFirst) return r.listAfterFirst(lists);
        return json({
          briefs: lists > 1 && r.afterDelete ? r.afterDelete : (r.briefs ?? [demo, other]),
        });
      }
      return json(EMPTY_REPORT);
    },
  });
  return { lists: () => lists };
};

const confirmName = new RegExp(
  `^(${messages.deleteCampaignConfirm}|${messages.deleteCampaignPending})$`,
);
const confirm = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: confirmName });
const field = (dialog: HTMLElement, name = "demo") =>
  within(dialog).getByLabelText(messages.deleteCampaignTypeLabel(name));
const openDelete = async (user: ReturnType<typeof userEvent.setup>, name = "Delete demo") => {
  await screen.findByText("demo.yaml");
  const trigger = screen.getByRole("button", { name });
  await user.click(trigger);
  return {
    trigger,
    dialog: await screen.findByRole("dialog", { name: messages.deleteCampaignTitle }),
  };
};

describe("BriefPicker delete", () => {
  test("a Delete button sits on every row and names its campaign", async () => {
    route();
    renderWithRun(<BriefPicker />);
    await screen.findByText("demo.yaml");
    await screen.findByText("other.yaml");

    const demoDelete = screen.getByRole("button", { name: "Delete demo" });
    const otherDelete = screen.getByRole("button", { name: "Delete other" });
    expect(demoDelete.textContent).toBe("Delete");
    expect(otherDelete.textContent).toBe("Delete");
    expect(deletes).toHaveLength(0);
  });

  test("Delete opens a confirmation that is named and described and does not focus the destructive button", async () => {
    const user = userEvent.setup();
    route();
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);

    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const pickerDialog = screen.getByRole("dialog", { name: "Load a campaign brief" });
    expect(pickerDialog.hasAttribute("inert")).toBe(true);
    expect(pickerDialog.hasAttribute("aria-modal")).toBe(false);

    const close = within(dialog).getByRole("button", { name: "Close" });
    await waitFor(() => expect(document.activeElement).toBe(close));
    expect(document.activeElement).not.toBe(confirm(dialog));

    const describedId = field(dialog).getAttribute("aria-describedby");
    const described = document.getElementById(describedId!);
    expect(described?.textContent).toBe(messages.deleteCampaignWarning("demo"));

    expect(confirm(dialog).hasAttribute("disabled")).toBe(true);
  });

  test("the confirm button stays disabled for a near-miss name and enables only on the exact name", async () => {
    const user = userEvent.setup();
    route();
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);

    for (const wrong of ["dem", "Demo", "demo ", "demo2", "DEMO"]) {
      await user.clear(field(dialog));
      await user.type(field(dialog), wrong);
      expect(confirm(dialog).hasAttribute("disabled")).toBe(true);
      expect(deletes).toHaveLength(0);
    }
    await user.clear(field(dialog));
    await user.type(field(dialog), "demo");
    expect(confirm(dialog).hasAttribute("disabled")).toBe(false);
    await user.type(field(dialog), "x");
    expect(confirm(dialog).hasAttribute("disabled")).toBe(true);
  });

  test("Enter in the field sends no request while the name does not match", async () => {
    const user = userEvent.setup();
    route();
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);

    await user.type(field(dialog), "dem{Enter}");
    fireEvent.submit(dialog.querySelector("form")!);
    expect(deletes).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: messages.deleteCampaignTitle })).toBeTruthy();
  });

  test("a double click on Delete campaign sends exactly one request", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<Response>((resolve) => {
      release = () => resolve(json({ deletionId: "d1" }, 202));
    });
    route({ del: () => gate });
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);
    await user.type(field(dialog), "demo");

    const btn = confirm(dialog);
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    await waitFor(() => expect(deletes.length).toBeGreaterThan(0));
    expect(deletes).toHaveLength(1);

    release();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.deleteCampaignTitle })).toBeNull(),
    );
    expect(deletes).toHaveLength(1);
  });

  test("a 202 sends one DELETE to the campaign uuid and refetches the list", async () => {
    const user = userEvent.setup();
    const r = route({ afterDelete: [other, fresh] });
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);
    await user.type(field(dialog), "demo");
    fireEvent.click(confirm(dialog));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.deleteCampaignTitle })).toBeNull(),
    );
    expect(deletes).toEqual([`${API}/campaigns/${UUID}`]);
    expect(
      vi.mocked(globalThis.fetch).mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(true);
    await screen.findByText("fresh.yaml");
    expect(screen.queryByText("demo.yaml")).toBeNull();
    expect(r.lists()).toBe(2);
  });

  test("a refetch that still lists the deleted campaign does not bring its row back", async () => {
    const user = userEvent.setup();
    const r = route({ afterDelete: [demo, other] });
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);
    await user.type(field(dialog), "demo");
    fireEvent.click(confirm(dialog));
    await waitFor(() => expect(r.lists()).toBe(2));
    expect(screen.queryByText("demo.yaml")).toBeNull();
    expect(screen.getByText("other.yaml")).toBeTruthy();
  });

  test("without a campaign id in the listing the DELETE goes to the slug", async () => {
    const user = userEvent.setup();
    const r = route();
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user, "Delete other");
    await user.type(
      await within(dialog).findByLabelText(messages.deleteCampaignTypeLabel("other")),
      "other",
    );
    fireEvent.click(confirm(dialog));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.deleteCampaignTitle })).toBeNull(),
    );
    expect(deletes).toEqual([`${API}/campaigns/other`]);
    await waitFor(() => expect(r.lists()).toBe(2));
    expect(screen.queryByText("other.yaml")).toBeNull();
  });

  test("a 2xx other than 202 is a success too", async () => {
    const user = userEvent.setup();
    route({ del: () => new Response(null, { status: 204 }) });
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);
    await user.type(field(dialog), "demo");
    fireEvent.click(confirm(dialog));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.deleteCampaignTitle })).toBeNull(),
    );
    expect(screen.queryByText("demo.yaml")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("an older refetch that lands last does not bring back a campaign deleted after it", async () => {
    const user = userEvent.setup();
    const third = {
      file: "third.yaml",
      brief: { id: "third", targetRegion: "DE", products: [{ id: "a" }] },
    };
    let resolveOlder!: (v: Response) => void;
    let resolveNewer!: (v: Response) => void;
    const olderRefetch = new Promise<Response>((resolve) => {
      resolveOlder = resolve;
    });
    const newerRefetch = new Promise<Response>((resolve) => {
      resolveNewer = resolve;
    });
    const r = route({
      briefs: [demo, other, third],
      listAfterFirst: (index) => (index === 2 ? olderRefetch : newerRefetch),
    });
    renderWithRun(<BriefPicker />);
    await screen.findByText("demo.yaml");

    // Delete demo: its refetch (lists=2) hangs on the older deferred promise.
    const { dialog: d1 } = await openDelete(user);
    await user.type(field(d1, "demo"), "demo");
    fireEvent.click(confirm(d1));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.deleteCampaignTitle })).toBeNull(),
    );

    // Delete other before demo's refetch answered: its refetch (lists=3) hangs on the newer one.
    await screen.findByText("other.yaml");
    const trigger2 = screen.getByRole("button", { name: "Delete other" });
    await user.click(trigger2);
    const d2 = await screen.findByRole("dialog", { name: messages.deleteCampaignTitle });
    await user.type(
      await within(d2).findByLabelText(messages.deleteCampaignTypeLabel("other")),
      "other",
    );
    fireEvent.click(confirm(d2));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.deleteCampaignTitle })).toBeNull(),
    );

    // Resolve the NEWER snapshot first ([third]), then the OLDER one that still lists `other`.
    resolveNewer(json({ briefs: [third] }, 200));
    resolveOlder(json({ briefs: [other, third] }, 200));

    await waitFor(() => expect(r.lists()).toBe(3));
    await waitFor(() => {
      expect(screen.queryByText("demo.yaml")).toBeNull();
      expect(screen.queryByText("other.yaml")).toBeNull();
      expect(screen.getByText("third.yaml")).toBeTruthy();
    });
  });

  test("a failed refetch after a delete still removes the row", async () => {
    const user = userEvent.setup();
    route({ failReload: true });
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);
    await user.type(field(dialog), "demo");
    fireEvent.click(confirm(dialog));
    await waitFor(() => expect(screen.queryByText("demo.yaml")).toBeNull());
    expect(screen.getByText("other.yaml")).toBeTruthy();
    expect(screen.queryByText(/Could not load briefs/)).toBeNull();
  });

  test("deleting the open campaign routes to the bare brief page", async () => {
    const user = userEvent.setup();
    route({ briefs: [open, other] });
    renderWithRun(<BriefPicker />);
    await screen.findByText("summer.yaml");
    expect(screen.getByText("current")).toBeTruthy();

    const trigger = screen.getByRole("button", { name: "Delete summer-hydration-2026" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: messages.deleteCampaignTitle });
    await user.type(
      within(dialog).getByLabelText(messages.deleteCampaignTypeLabel("summer-hydration-2026")),
      "summer-hydration-2026",
    );
    fireEvent.click(confirm(dialog));
    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief"));
    expect(nextMock().router.push).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", { name: "Load a campaign brief" })).toBeTruthy();
  });

  test("deleting another campaign does not navigate", async () => {
    const user = userEvent.setup();
    const r = route({ briefs: [open, other] });
    renderWithRun(<BriefPicker />);
    await screen.findByText("summer.yaml");

    const trigger = screen.getByRole("button", { name: "Delete other" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: messages.deleteCampaignTitle });
    await user.type(
      await within(dialog).findByLabelText(messages.deleteCampaignTypeLabel("other")),
      "other",
    );
    fireEvent.click(confirm(dialog));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.deleteCampaignTitle })).toBeNull(),
    );
    expect(nextMock().router.push).not.toHaveBeenCalled();
    await waitFor(() => expect(r.lists()).toBe(2));
    expect(screen.queryByText("other.yaml")).toBeNull();
  });

  test("a 409 says a run is in progress and offers no way to cancel it", async () => {
    const user = userEvent.setup();
    route({
      del: () => json({ error: 'Campaign "demo" has a run in progress.', jobId: "j1" }, 409),
    });
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);
    await user.type(field(dialog), "demo");
    fireEvent.click(confirm(dialog));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      messages.deleteCampaignRunInProgress,
    );
    expect(screen.getByRole("dialog", { name: messages.deleteCampaignTitle })).toBeTruthy();
    expect(screen.getByText("demo.yaml")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /cancel (the )?run|stop/i })).toBeNull();
    expect(confirm(dialog).hasAttribute("disabled")).toBe(false);
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("a 403 says the user may not delete the campaign", async () => {
    const user = userEvent.setup();
    route({ del: () => json({ error: 'You may not delete campaign "demo".' }, 403) });
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);
    await user.type(field(dialog), "demo");
    fireEvent.click(confirm(dialog));
    expect(await screen.findByText(messages.deleteCampaignForbidden)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: messages.deleteCampaignTitle })).toBeTruthy();
    expect(screen.getByText("demo.yaml")).toBeTruthy();
  });

  test("a 403 with no_membership shows the organisation message and is not mistaken for a plain 403", async () => {
    const user = userEvent.setup();
    route({
      del: () => json({ error: NO_ORGANISATION_YET_MESSAGE, code: "no_membership" }, 403),
    });
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);
    await user.type(field(dialog), "demo");
    fireEvent.click(confirm(dialog));
    expect(await screen.findByText(NO_ORGANISATION_YET_MESSAGE)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: messages.deleteCampaignTitle })).toBeTruthy();
  });

  test("a 404 says the campaign is already gone and drops its row", async () => {
    const user = userEvent.setup();
    route({ afterDelete: [other], del: () => json({ error: 'Campaign "demo" not found.' }, 404) });
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);
    await user.type(field(dialog), "demo");
    fireEvent.click(confirm(dialog));
    expect(await screen.findByText(messages.deleteCampaignGone)).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("demo.yaml")).toBeNull());
    expect(screen.getByRole("dialog", { name: messages.deleteCampaignTitle })).toBeTruthy();
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("a 501 says the server cannot delete campaigns", async () => {
    const user = userEvent.setup();
    route({
      del: () => json({ error: "Deleting a campaign needs STORE_BACKEND=postgres." }, 501),
    });
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);
    await user.type(field(dialog), "demo");
    fireEvent.click(confirm(dialog));
    expect(await screen.findByText(messages.deleteCampaignUnsupported)).toBeTruthy();
    expect(screen.queryByText("Deleting a campaign needs STORE_BACKEND=postgres.")).toBeNull();
    expect(screen.getByText("demo.yaml")).toBeTruthy();
  });

  test("any other failure shows the server message and allows a retry", async () => {
    const user = userEvent.setup();
    let calls = 0;
    route({
      del: () => {
        calls += 1;
        return calls === 1 ? json({ error: "boom" }, 500) : json({ deletionId: "d2" }, 202);
      },
    });
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);
    await user.type(field(dialog), "demo");
    fireEvent.click(confirm(dialog));

    expect(await screen.findByText("boom")).toBeTruthy();
    const again = confirm(dialog);
    fireEvent.click(again);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.deleteCampaignTitle })).toBeNull(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(deletes).toHaveLength(2);
  });

  test("Cancel closes the confirmation, sends nothing and returns focus to the Delete button", async () => {
    const user = userEvent.setup();
    route();
    renderWithRun(<BriefPicker />);
    const { trigger, dialog } = await openDelete(user);

    await user.click(within(dialog).getByRole("button", { name: messages.confirmCancel }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.deleteCampaignTitle })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    const pickerDialog = screen.getByRole("dialog", { name: "Load a campaign brief" });
    expect(pickerDialog.hasAttribute("inert")).toBe(false);
    expect(deletes).toHaveLength(0);
  });

  test("Escape closes the confirmation, sends nothing and returns focus to the Delete button", async () => {
    const user = userEvent.setup();
    route();
    renderWithRun(<BriefPicker />);
    const { trigger } = await openDelete(user);

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.deleteCampaignTitle })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.getByRole("dialog", { name: "Load a campaign brief" })).toBeTruthy();
    expect(deletes).toHaveLength(0);
  });

  test("Tab and Shift-Tab stay inside the confirmation", async () => {
    const user = userEvent.setup();
    route();
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);

    const close = within(dialog).getByRole("button", { name: "Close" });
    const cancel = within(dialog).getByRole("button", { name: messages.confirmCancel });
    cancel.focus();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.tab();
    expect(document.activeElement).toBe(close);
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cancel);
    expect(dialog.contains(document.activeElement)).toBe(true);

    exerciseFocusTrap(dialog);
  });

  test("a delete in flight disables both buttons and ignores Escape", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<Response>((resolve) => {
      release = () => resolve(json({ deletionId: "d1" }, 202));
    });
    route({ del: () => gate });
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);
    await user.type(field(dialog), "demo");
    fireEvent.click(confirm(dialog));

    const pendingConfirm = await within(dialog).findByText(messages.deleteCampaignPending);
    expect(pendingConfirm.closest("button")?.hasAttribute("disabled")).toBe(true);
    expect(
      within(dialog).getByRole("button", { name: messages.confirmCancel }).hasAttribute("disabled"),
    ).toBe(true);

    await user.keyboard("{Escape}");
    fireEvent.click(dialog);
    expect(screen.getByRole("dialog", { name: messages.deleteCampaignTitle })).toBeTruthy();

    release();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.deleteCampaignTitle })).toBeNull(),
    );
  });

  test("the whole flow works from the keyboard alone", async () => {
    const user = userEvent.setup();
    route();
    renderWithRun(<BriefPicker />);
    await screen.findByText("demo.yaml");

    const trigger = screen.getByRole("button", { name: "Delete demo" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: messages.deleteCampaignTitle });

    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(field(dialog));
    await user.keyboard("demo");
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.deleteCampaignTitle })).toBeNull(),
    );
    expect(deletes).toHaveLength(1);
  });

  test("after a delete focus stays inside the picker", async () => {
    const user = userEvent.setup();
    route({ afterDelete: [other, fresh] });
    renderWithRun(<BriefPicker />);
    const { dialog } = await openDelete(user);
    await user.type(field(dialog), "demo");
    fireEvent.click(confirm(dialog));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.deleteCampaignTitle })).toBeNull(),
    );
    const pickerDialog = screen.getByRole("dialog", { name: "Load a campaign brief" });
    await waitFor(() => expect(pickerDialog.contains(document.activeElement)).toBe(true));
  });
});
