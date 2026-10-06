import { describe, test, expect } from "vitest";
import { screen, within, waitFor } from "@testing-library/react";
import { createElement } from "react";
import userEvent from "@testing-library/user-event";
import type { Asset } from "@/lib/run-context";
import { renderWithRun, seedPersistedRun } from "@/__tests__/helpers";
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

    // Open the bin through the real Sidebar, then delete logo through the real drawer.
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
    // No `id`: the fs store answers name-only entries, so the Sidebar's
    // `a.id ?? a.name` and `gone.id ?? gone.name` filters both fall to the name.
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
});
