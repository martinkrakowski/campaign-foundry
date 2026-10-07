import { describe, test, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import { createElement } from "react";
import userEvent from "@testing-library/user-event";
import type { Asset } from "@/lib/run-context";
import { renderWithRun, seedPersistedRun, mockPipelineApi, json } from "@/__tests__/helpers";
import { Sidebar } from "../Sidebar";
import * as messages from "@/components/campaign/messages";

const logo = {
  id: "11111111-2222-4333-8444-555555555555",
  name: "logo.png",
  type: "image/png",
  size: 2048,
  thumbnailUrl: "",
} as unknown as Asset;
const banner = {
  id: "22222222-3333-4444-8555-666666666666",
  name: "banner.png",
  type: "image/png",
  size: 512,
  thumbnailUrl: "",
} as unknown as Asset;

describe("Sidebar Project Bin delete", () => {
  test("deleting an asset from the bin updates the count and removes its preview", async () => {
    const user = userEvent.setup();
    seedPersistedRun([logo, banner]);
    renderWithRun(createElement(Sidebar));
    await screen.findByText("logo.png");
    expect(screen.getByText("2 assets")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Browse" }));
    const drawer = await screen.findByRole("dialog", { name: "Asset Bin" });
    await user.click(
      within(drawer).getByRole("button", { name: messages.assetDeleteRowLabel("logo.png") }),
    );
    const confirmDialog = await screen.findByRole("dialog", { name: messages.assetDeleteTitle });
    await user.click(
      within(confirmDialog).getByRole("button", { name: messages.assetDeleteConfirm }),
    );

    await waitFor(() => expect(screen.getByText("1 asset")).toBeTruthy());
    expect(screen.queryByText("logo.png")).toBeNull();
  });

  test("deleting a name-only asset (the fs shape) updates the count and removes its preview", async () => {
    const user = userEvent.setup();
    const onlyLogo = {
      name: "logo.png",
      type: "image/png",
      size: 2048,
      thumbnailUrl: "",
    } as unknown as Asset;
    const onlyBanner = {
      name: "banner.png",
      type: "image/png",
      size: 512,
      thumbnailUrl: "",
    } as unknown as Asset;
    seedPersistedRun([onlyLogo, onlyBanner]);
    renderWithRun(createElement(Sidebar));
    await screen.findByText("logo.png");
    expect(screen.getByText("2 assets")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Browse" }));
    const drawer = await screen.findByRole("dialog", { name: "Asset Bin" });
    await user.click(
      within(drawer).getByRole("button", { name: messages.assetDeleteRowLabel("logo.png") }),
    );
    const confirmDialog = await screen.findByRole("dialog", { name: messages.assetDeleteTitle });
    await user.click(
      within(confirmDialog).getByRole("button", { name: messages.assetDeleteConfirm }),
    );

    await waitFor(() => expect(screen.getByText("1 asset")).toBeTruthy());
    expect(screen.queryByText("logo.png")).toBeNull();
  });

  test("a stale listAssets response does not restore a deleted Sidebar row (PROVE DEFECT)", async () => {
    const user = userEvent.setup();
    const opened = seedPersistedRun([logo, banner]);

    let resolveSidebarList!: (v: Response) => void;
    const sidebarResponse = new Promise<Response>((r) => (resolveSidebarList = r));
    let firstSeedCallDone = false;

    mockPipelineApi({
      opened,
      result: (url, req) => {
        const method = req?.method ?? "GET";
        if (method === "DELETE") return json({ deleted: true });
        if (method === "GET" && url.includes("/campaigns/assets")) {
          if (url.includes("briefId=seed") && !firstSeedCallDone) {
            firstSeedCallDone = true;
            return sidebarResponse;
          }
          return json({ assets: [logo, banner] });
        }
        return json({ halted: false, assets: [logo, banner], log: null });
      },
    });

    renderWithRun(createElement(Sidebar));

    // Wait for the campaign to load and the Sidebar effect to fire for briefId="seed".
    await screen.findByText("Project Bin");
    await waitFor(() => expect(screen.getByText("0 assets")).toBeTruthy());

    // Open the drawer — its listAssets GET resolves immediately with both assets.
    await user.click(screen.getByRole("button", { name: "Browse" }));
    const drawer = await screen.findByRole("dialog", { name: "Asset Bin" });
    await within(drawer).findByText("logo.png");

    // Delete logo through the real drawer.
    await user.click(
      within(drawer).getByRole("button", { name: messages.assetDeleteRowLabel("logo.png") }),
    );
    const confirmDialog = await screen.findByRole("dialog", { name: messages.assetDeleteTitle });
    await user.click(
      within(confirmDialog).getByRole("button", { name: messages.assetDeleteConfirm }),
    );

    // onDeleted has run — the Sidebar's deleted row is filtered out. The Sidebar's
    // own listAssets is still pending, so it's still "0 assets" here; the delete
    // still happened (the DELETE reached the server and onDeleted fired).
    await waitFor(() => expect(screen.queryByText("logo.png")).toBeNull());

    // Close the drawer so banner.png appears only in the Sidebar's own list when
    // the stale response lands — otherwise it also lives in the drawer and the
    // `getByText("banner.png")` below cannot tell them apart.
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Asset Bin" })).toBeNull());

    // NOW resolve the stale Sidebar listAssets response with BOTH assets still in it.
    resolveSidebarList(json({ assets: [logo, banner] }));

    // Without the fix the late response calls setAssets([logo, banner]) and logo
    // reappears. With the fix the deleted key is still filtered, so logo stays gone
    // AND banner is still shown — a test that only checked "logo gone" would also
    // pass if the fix threw the whole response away.
    await waitFor(() => {
      expect(screen.queryByText("logo.png")).toBeNull();
      expect(screen.getByText("banner.png")).toBeTruthy();
    });
  });
});
