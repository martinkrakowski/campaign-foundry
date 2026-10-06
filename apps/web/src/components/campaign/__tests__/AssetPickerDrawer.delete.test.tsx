import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EMPTY_REPORT, json, mockPipelineApi, exerciseFocusTrap } from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
import { NO_ORGANISATION_YET_MESSAGE } from "@/lib/auth-errors";
import * as messages from "@/components/campaign/messages";
import { AssetPickerDrawer } from "../AssetPickerDrawer";

const ID_LOGO = "11111111-2222-4333-8444-555555555555";
const ID_BANNER = "22222222-3333-4444-8555-666666666666";
const ID_GHOST = "33333333-4444-4555-8666-777777777777";
const logo = { id: ID_LOGO, name: "logo.png", type: "image/png", size: 2048, thumbnailUrl: "" };
const banner = {
  id: ID_BANNER,
  name: "banner.png",
  type: "image/png",
  size: 512,
  thumbnailUrl: "",
};
const ghost = { id: ID_GHOST, name: "ghost.png", type: "image/png", size: 64, thumbnailUrl: "" };
const plain = { name: "plain.png", type: "image/png", size: 128, thumbnailUrl: "" };

interface Route {
  /** The Nth list GET answers `lists[N]` (the last one repeats). */
  lists?: unknown[][];
  /** Hold the Nth list GET (0-based) until the returned function is called. */
  hold?: number[];
  del?: (url: string) => Response | Promise<Response>;
  /** List GETs (0-based) that answer a 500. */
  fail?: number[];
}
const requests: { method: string; url: string }[] = [];
const route = (r: Route = {}) => {
  let gets = 0;
  const releases = new Map<number, () => void>();
  requests.length = 0;
  mockPipelineApi({
    result: (url, req) => {
      const method = req?.method ?? "GET";
      if (!url.includes("/campaigns/assets")) return json(EMPTY_REPORT);
      requests.push({ method, url });
      if (method === "DELETE") return r.del ? r.del(url) : json({ deleted: true });
      const n = gets++;
      if (r.fail?.includes(n)) return json({ error: "x" }, 500);
      const body = {
        assets: (r.lists ?? [[logo, banner]])[Math.min(n, (r.lists ?? [[]]).length - 1)],
      };
      if (r.hold?.includes(n)) {
        return new Promise<Response>((resolve) => releases.set(n, () => resolve(json(body))));
      }
      return json(body);
    },
  });
  return { release: (n: number) => releases.get(n)?.(), gets: () => gets };
};
const deletes = () => requests.filter((q) => q.method === "DELETE");

const renderDrawer = (props = {}) =>
  render(<AssetPickerDrawer briefId="camp-1" open onClose={() => {}} {...props} />);
const openDelete = async (user: ReturnType<typeof userEvent.setup>, name = "logo.png") => {
  const trigger = await screen.findByRole("button", { name: messages.assetDeleteRowLabel(name) });
  await user.click(trigger);
  return {
    trigger,
    dialog: await screen.findByRole("dialog", { name: messages.assetDeleteTitle }),
  };
};
const confirm = (dialog: HTMLElement) =>
  within(dialog).getByRole("button", { name: messages.assetDeleteConfirm });

describe("AssetPickerDrawer delete", () => {
  beforeEach(() => vi.restoreAllMocks());

  test("a Delete button sits on every row and names its asset", async () => {
    route({ lists: [[logo, banner, plain]] });
    renderDrawer();
    await screen.findByText("logo.png");

    for (const asset of [logo, banner, plain]) {
      const button = screen.getByRole("button", {
        name: messages.assetDeleteRowLabel(asset.name),
      });
      expect(button).toBeTruthy();
      expect(button.textContent).toBe(messages.assetDeleteAction);
    }
    expect(deletes()).toHaveLength(0);
  });

  test("Delete opens a named confirmation and sends nothing until it is confirmed", async () => {
    const user = userEvent.setup();
    route({ lists: [[logo, banner]] });
    renderDrawer();

    await user.click(
      await screen.findByRole("button", { name: messages.assetDeleteRowLabel("logo.png") }),
    );
    expect(deletes()).toHaveLength(0);

    const dialog = await screen.findByRole("dialog", { name: messages.assetDeleteTitle });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText(messages.assetDeleteMessage("logo.png"))).toBeTruthy();
    // The drawer (below) is inert and not modal while its confirmation is open (D84).
    const drawer = document.querySelector('[aria-label="Asset Bin"]')!;
    expect(drawer.hasAttribute("inert")).toBe(true);
    expect(drawer.getAttribute("aria-modal")).toBeNull();
    expect(deletes()).toHaveLength(0);
    expect(screen.queryByText("logo.png")).toBeTruthy();
  });

  test("Cancel closes the confirmation, sends nothing and returns focus to the Delete button", async () => {
    const user = userEvent.setup();
    route({ lists: [[logo, banner]] });
    renderDrawer();

    const { dialog } = await openDelete(user);
    await user.click(within(dialog).getByRole("button", { name: messages.confirmCancel }));

    expect(screen.queryByRole("dialog", { name: messages.assetDeleteTitle })).toBeNull();
    expect(screen.getByRole("button", { name: messages.assetDeleteRowLabel("logo.png") })).toBe(
      document.activeElement,
    );
    expect(deletes()).toHaveLength(0);
    expect(document.querySelector('[aria-label="Asset Bin"]')!.hasAttribute("inert")).toBe(false);
  });

  test("Escape closes the confirmation only and the drawer stays open", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    route({ lists: [[logo, banner]] });
    renderDrawer({ onClose });

    const { dialog } = await openDelete(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: messages.assetDeleteTitle })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Asset Bin" })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(deletes()).toHaveLength(0);
  });

  test("Tab stays inside the confirmation", async () => {
    const user = userEvent.setup();
    route({ lists: [[logo, banner]] });
    renderDrawer();

    const { dialog } = await openDelete(user);
    exerciseFocusTrap(dialog);
    await user.tab();
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement as Node)).toBe(true);
  });

  test("confirming sends exactly one DELETE with the asset id and removes the row", async () => {
    const user = userEvent.setup();
    const r = route({ lists: [[logo, banner], [banner]] });
    renderDrawer();
    await screen.findByText("logo.png");

    const { dialog } = await openDelete(user);
    await user.click(confirm(dialog));

    await waitFor(() => expect(screen.queryByText("logo.png")).toBeNull());
    expect(deletes()).toEqual([
      { method: "DELETE", url: `${API}/campaigns/assets?briefId=camp-1&id=${ID_LOGO}` },
    ]);
    expect(screen.getByText("banner.png")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(messages.assetDeleted("logo.png"));
  });

  test("an entry with no id is deleted by name", async () => {
    const user = userEvent.setup();
    const r = route({ lists: [[plain, banner], [banner]] });
    renderDrawer();
    await screen.findByText("plain.png");

    const { dialog } = await openDelete(user, "plain.png");
    await user.click(confirm(dialog));

    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(deletes()[0].url).toBe(`${API}/campaigns/assets?briefId=camp-1&name=plain.png`);
    expect(deletes()[0].url).not.toContain("id=");
    await waitFor(() => expect(screen.queryByText("plain.png")).toBeNull());
  });

  test("a double click on Delete asset sends exactly one request", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const gate = new Promise<Response>((resolve) => {
      release = () => resolve(json({ deleted: true }));
    });
    const r = route({ lists: [[logo, banner], [banner]], del: () => gate });
    renderDrawer();
    await screen.findByText("logo.png");

    const { dialog } = await openDelete(user);
    const btn = confirm(dialog);
    await act(() => {
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    await waitFor(() => expect(deletes().length).toBeGreaterThan(0));
    expect(deletes()).toHaveLength(1);

    release!();
    await waitFor(() => expect(screen.queryByText("logo.png")).toBeNull());
    expect(deletes()).toHaveLength(1);
  });

  test("a delete in flight disables every Delete button and shows Deleting", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const gate = new Promise<Response>((resolve) => {
      release = () => resolve(json({ deleted: true }));
    });
    const r = route({ lists: [[logo, banner], [banner]], del: () => gate });
    renderDrawer();
    await screen.findByText("logo.png");

    const { dialog } = await openDelete(user);
    await user.click(confirm(dialog));

    const pendingBtn = await screen.findByRole("button", { name: messages.assetDeletePending });
    expect(pendingBtn.textContent).toBe(messages.assetDeletePending);
    expect(pendingBtn.hasAttribute("disabled")).toBe(true);
    const bannerBtn = screen.getByRole("button", {
      name: messages.assetDeleteRowLabel("banner.png"),
    });
    expect(bannerBtn.hasAttribute("disabled")).toBe(true);

    release!();
    await waitFor(() => expect(screen.queryByText("logo.png")).toBeNull());
    const bannerAfter = await screen.findByRole("button", {
      name: messages.assetDeleteRowLabel("banner.png"),
    });
    expect(bannerAfter.hasAttribute("disabled")).toBe(false);
  });

  test("after a delete focus moves to the list header and the deletion is announced", async () => {
    const user = userEvent.setup();
    const r = route({ lists: [[logo, banner], [banner]] });
    renderDrawer();
    await screen.findByText("logo.png");

    const { dialog } = await openDelete(user);
    await user.click(confirm(dialog));

    await waitFor(() => expect(screen.queryByText("logo.png")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByText("Assets (1)").parentElement),
    );
    expect(screen.getByRole("status").textContent).toBe(messages.assetDeleted("logo.png"));
  });

  test("a refetch that still lists the deleted asset never brings it back", async () => {
    const user = userEvent.setup();
    const r = route({
      lists: [
        [logo, banner],
        [logo, banner],
      ],
    });
    renderDrawer();
    await screen.findByText("logo.png");

    const { dialog } = await openDelete(user);
    await user.click(confirm(dialog));

    await waitFor(() => expect(r.gets()).toBe(2));
    expect(screen.queryByText("logo.png")).toBeNull();
    expect(screen.getByText("banner.png")).toBeTruthy();
  });

  test("a refetch that lands after a second delete never restores either row", async () => {
    const ID_LATE = "44444444-4444-4555-8666-777777777777";
    const late = { id: ID_LATE, name: "late.png", type: "image/png", size: 32, thumbnailUrl: "" };
    const user = userEvent.setup();
    const r = route({
      lists: [[logo, banner, ghost], [banner, ghost, late], [ghost]],
      hold: [1],
    });
    renderDrawer();
    await screen.findByText("logo.png");

    // delete logo.png: its refetch (list GET 1) is held.
    const { dialog: d1 } = await openDelete(user);
    await user.click(confirm(d1));
    await waitFor(() => expect(screen.queryByText("logo.png")).toBeNull());

    // delete banner.png: its refetch (GET 2) answers [ghost].
    const { dialog: d2 } = await openDelete(user, "banner.png");
    await user.click(confirm(d2));
    await screen.findByText("ghost.png");

    // the OLD refetch (GET 1) lands with [banner, ghost, late]; `late` proves the
    // held response arrived, `banner`'s absence proves it was filtered.
    await act(async () => {
      r.release(1);
    });
    await screen.findByText("late.png");
    expect(screen.queryByText("banner.png")).toBeNull();
    expect(screen.queryByText("logo.png")).toBeNull();
    expect(screen.getByText("ghost.png")).toBeTruthy();
  });

  test("a refetch that began before the drawer was reopened is ignored", async () => {
    const user = userEvent.setup();
    const r = route({
      lists: [[logo, banner], [logo, banner, ghost], [banner]],
      hold: [1],
    });
    const { rerender } = renderDrawer();
    await screen.findByText("logo.png");

    // delete logo.png: its refetch (list GET 1) is held.
    const { dialog } = await openDelete(user);
    await user.click(confirm(dialog));
    await waitFor(() => expect(screen.queryByText("logo.png")).toBeNull());

    // close then reopen: the reopen's load is list GET 2 and answers [banner].
    rerender(<AssetPickerDrawer briefId="camp-1" open={false} onClose={() => {}} />);
    rerender(<AssetPickerDrawer briefId="camp-1" open onClose={() => {}} />);
    await screen.findByText("banner.png");

    // the old refetch (GET 1) lands with [logo, banner, ghost] but is ignored by the
    // epoch guard a reopening bump installed.
    await act(async () => {
      r.release(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("ghost.png")).toBeNull();
    expect(screen.getByText("banner.png")).toBeTruthy();
  });

  test("a delete that finishes after the drawer was closed does not throw", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    let settled = false;
    const gate = new Promise<Response>((resolve) => {
      release = () => {
        settled = true;
        resolve(json({ deleted: true }));
      };
    });
    const consoleError = vi.spyOn(console, "error");
    const r = route({
      lists: [[logo, banner], [logo, banner, ghost], [banner]],
      hold: [1],
      del: () => gate,
    });
    const { rerender } = renderDrawer();
    await screen.findByText("logo.png");

    // confirm the delete: the DELETE is held by `gate`, so it has not resolved.
    const { dialog } = await openDelete(user);
    await user.click(confirm(dialog));

    // close while the delete is still in flight.
    rerender(<AssetPickerDrawer briefId="camp-1" open={false} onClose={() => {}} />);

    // let the held DELETE resolve: forget() runs and issues its refetch (GET 1, still
    // held), and focusTick fires on a closed drawer (headingRef is null) — must not
    // throw or log.
    await act(async () => {
      release!();
      await gate;
    });
    expect(settled).toBe(true);
    expect(consoleError).not.toHaveBeenCalled();

    // reopen: the reopen's load (GET 2) answers [banner]; the old refetch (GET 1) is
    // released and must be ignored by the epoch guard.
    rerender(<AssetPickerDrawer briefId="camp-1" open onClose={() => {}} />);
    await screen.findByText("banner.png");
    await act(async () => {
      r.release(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("ghost.png")).toBeNull();
    expect(screen.getByText("banner.png")).toBeTruthy();
  });

  test("the whole flow works from the keyboard alone", async () => {
    const user = userEvent.setup();
    const r = route({ lists: [[logo, banner], [banner]] });
    renderDrawer();
    await screen.findByText("logo.png");

    const trigger = await screen.findByRole("button", {
      name: messages.assetDeleteRowLabel("logo.png"),
    });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    await user.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog", { name: messages.assetDeleteTitle });
    const confirmBtn = within(dialog).getByRole("button", { name: messages.assetDeleteConfirm });
    for (let i = 0; i < 10 && document.activeElement !== confirmBtn; i++) {
      await user.tab();
    }
    expect(document.activeElement).toBe(confirmBtn);

    await user.keyboard("{Enter}");
    expect(deletes()).toHaveLength(1);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.assetDeleteTitle })).toBeNull(),
    );
  });

  test("a 409 says the asset is still used and keeps the row", async () => {
    const user = userEvent.setup();
    const r = route({
      lists: [[logo, banner], [banner]],
      del: () => json({ error: 'Asset "logo.png" is in use.' }, 409),
    });
    renderDrawer();
    await screen.findByText("logo.png");

    const { dialog } = await openDelete(user);
    await user.click(confirm(dialog));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(messages.assetDeleteInUse("logo.png"));
    expect(screen.getByText("logo.png")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: messages.assetDeleteRowLabel("logo.png") })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(deletes()).toHaveLength(1);
    expect(
      screen.getByRole("dialog", { name: "Asset Bin" }).contains(document.activeElement as Node),
    ).toBe(true);
  });

  test("a 404 removes the row and says the asset is already gone", async () => {
    const user = userEvent.setup();
    const r = route({
      lists: [[logo, banner], [banner]],
      del: () => json({ error: "x" }, 404),
    });
    renderDrawer();
    await screen.findByText("logo.png");

    const { dialog } = await openDelete(user);
    await user.click(confirm(dialog));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(messages.assetDeleteGone("logo.png"));
    expect(screen.queryByText("logo.png")).toBeNull();
    expect(screen.getByText("banner.png")).toBeTruthy();
  });

  test("any other failure shows the server message and allows a retry", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const r = route({
      lists: [[logo, banner], [banner]],
      del: () => {
        const res = calls === 0 ? json({ error: "boom" }, 500) : json({ deleted: true });
        calls += 1;
        return res;
      },
    });
    renderDrawer();
    await screen.findByText("logo.png");

    const { dialog: first } = await openDelete(user);
    await user.click(confirm(first));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("boom");
    expect(screen.getByText("logo.png")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: messages.assetDeleteRowLabel("logo.png") })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen.getByRole("dialog", { name: "Asset Bin" }).contains(document.activeElement as Node),
    ).toBe(true);

    const { dialog: second } = await openDelete(user);
    await user.click(confirm(second));
    await waitFor(() => expect(screen.queryByText("logo.png")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(messages.assetDeleted("logo.png"));
    expect(deletes()).toHaveLength(2);
  });

  test("a failure with no message shows the request failed text", async () => {
    const user = userEvent.setup();
    const r = route({
      lists: [[logo, banner], [banner]],
      del: () => new Response("", { status: 500 }),
    });
    renderDrawer();
    await screen.findByText("logo.png");

    const { dialog } = await openDelete(user);
    await user.click(confirm(dialog));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Request failed (HTTP 500)");
    expect(screen.getByText("logo.png")).toBeTruthy();
  });

  test("a 403 with no_membership shows the organisation message", async () => {
    const user = userEvent.setup();
    const r = route({
      lists: [[logo, banner], [banner]],
      del: () => json({ error: NO_ORGANISATION_YET_MESSAGE, code: "no_membership" }, 403),
    });
    renderDrawer();
    await screen.findByText("logo.png");

    const { dialog } = await openDelete(user);
    await user.click(confirm(dialog));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(NO_ORGANISATION_YET_MESSAGE);
  });

  test("a failed refetch after a delete leaves the list as it was", async () => {
    const user = userEvent.setup();
    const r = route({ lists: [[logo, banner]], fail: [1] });
    renderDrawer();
    await screen.findByText("logo.png");

    const { dialog } = await openDelete(user);
    await user.click(confirm(dialog));

    await waitFor(() => expect(screen.queryByText("logo.png")).toBeNull());
    expect(screen.getByText("banner.png")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("the selected asset has no Delete button and says why", async () => {
    route({ lists: [[logo, banner]] });
    const first = renderDrawer({ onSelect: vi.fn(), selectedRef: ID_LOGO });
    await screen.findByText("logo.png");
    expect(
      screen.queryByRole("button", { name: messages.assetDeleteRowLabel("logo.png") }),
    ).toBeNull();
    expect(screen.getByText(messages.assetDeleteSelectedHint)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: messages.assetDeleteRowLabel("banner.png") }),
    ).toBeTruthy();
    first.unmount();

    route({ lists: [[plain, banner]] });
    renderDrawer({ onSelect: vi.fn(), selectedRef: "assets/inputs/camp-1/plain.png" });
    await screen.findByText("plain.png");
    expect(
      screen.queryByRole("button", { name: messages.assetDeleteRowLabel("plain.png") }),
    ).toBeNull();
    expect(screen.getByText(messages.assetDeleteSelectedHint)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: messages.assetDeleteRowLabel("banner.png") }),
    ).toBeTruthy();
  });

  test("the Sidebar drawer without onSelect can delete too", async () => {
    const user = userEvent.setup();
    const r = route({ lists: [[logo, banner], [banner]] });
    renderDrawer();
    await screen.findByText("logo.png");

    expect(screen.getAllByLabelText("Hero asset")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: messages.assetDeleteRowLabel("logo.png") }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: messages.assetDeleteRowLabel("banner.png") }),
    ).toBeTruthy();

    const { dialog } = await openDelete(user);
    await user.click(confirm(dialog));
    await waitFor(() => expect(screen.queryByText("logo.png")).toBeNull());
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0].url).toBe(`${API}/campaigns/assets?briefId=camp-1&id=${ID_LOGO}`);
  });
});
