import { describe, test, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateCampaignProvider, useCreateCampaign } from "@/lib/create-campaign-context";
import { CREATE_SEED_KEY } from "@/lib/create-campaign";
import { nextMock } from "@/__tests__/helpers";
import * as messages from "@/components/campaign/messages";
import { CreateCampaignDialog } from "../CreateCampaignDialog";

/** Opens the dialog the way the shell's entry points do, so the closed state is real. */
const Harness = () => {
  const { openCreateDialog } = useCreateCampaign();
  return (
    <>
      <button type="button" onClick={openCreateDialog}>
        open
      </button>
      <CreateCampaignDialog />
    </>
  );
};

const renderDialog = () => render(<CreateCampaignProvider><Harness /></CreateCampaignProvider>);

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "open" }));
  await screen.findByRole("dialog", { name: messages.createCampaignTitle });
};

const fillValid = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");
  await user.click(screen.getByRole("button", { name: "EU" }));
  await user.type(screen.getByLabelText(messages.targetAudienceLabel), "trail runners");
};

beforeEach(() => {
  localStorage.clear();
  nextMock().nav.pathname = "/grid";
});

describe("CreateCampaignDialog", () => {
  test("collects the four things the Identity step decides, with Classic preselected", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    expect(screen.getByLabelText(messages.campaignNameLabel)).toBeTruthy();
    for (const option of ["GLOBAL", "EU", "DE", "UK", "US", "APAC", messages.targetRegionOther]) {
      expect(screen.getByRole("button", { name: option })).toBeTruthy();
    }
    expect(screen.getByLabelText(messages.targetAudienceLabel)).toBeTruthy();
    // The mode cards keep the kit's raw-value name; Classic ("brief") is the default.
    expect(screen.getByRole("button", { name: "brief" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "variation" }).getAttribute("aria-pressed")).toBe("false");
  });

  test("the region's Other… escape reveals the free-text input, as Identity renders it", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: messages.targetRegionOther }));
    expect(screen.getByLabelText(messages.targetRegionOtherInputLabel)).toBeTruthy();
  });

  test("Create with an empty name is refused in the status line, and the dialog stays open", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    expect(screen.getByRole("status").textContent).toBe(messages.campaignNameRequired);
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    // A refused create is not a create: nothing was published.
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
  });

  test("Create with an empty region is refused in the status line", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    expect(screen.getByRole("status").textContent).toBe(messages.targetRegion);
  });

  test("Create with an empty audience is refused in the status line", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");
    await user.click(screen.getByRole("button", { name: "EU" }));
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    expect(screen.getByRole("status").textContent).toBe(messages.targetAudience);
  });

  test("the dialog never shows the slug the name derives (D65)", async () => {
    const user = userEvent.setup();
    const { container } = renderDialog();
    await openDialog(user);
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");

    expect(container.textContent).not.toContain("summer-spark");
  });

  test("Create from elsewhere stashes the Copy step, closes the dialog, and pushes the seam's route", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new"));
    // D66: the landing branch belongs to the caller — off the blank route the baton
    // crosses the navigation this push causes.
    expect(localStorage.getItem("cf:step-handoff")).toBe("copy");
    // D67: the create is not a cancelled one — the seed rides along for the editor.
    expect(JSON.parse(localStorage.getItem(CREATE_SEED_KEY) as string)).toEqual({
      name: "Summer Spark",
      targetRegion: "EU",
      targetAudience: "trail runners",
      mode: "brief",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull(),
    );
  });

  test("Create on the blank route leaves the baton to the mounted editor's seed effect", async () => {
    nextMock().nav.pathname = "/brief/new";
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new"));
    // Never both: in place, the editor's seed effect moves the cursor itself.
    expect(localStorage.getItem("cf:step-handoff")).toBeNull();
  });

  test("the mode choice rides the seed", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "variation" }));
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new"));
    expect(JSON.parse(localStorage.getItem(CREATE_SEED_KEY) as string).mode).toBe("variation");
  });

  test("a blocked store keeps the dialog open, says so, and neither navigates nor leaves a seed", async () => {
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const user = userEvent.setup();
    try {
      renderDialog();
      await openDialog(user);
      await fillValid(user);
      await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

      expect(await screen.findByRole("status")).toBeTruthy();
      expect(screen.getByRole("status").textContent).toBe(messages.createCampaignBlocked);
      expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
      expect(nextMock().router.push).not.toHaveBeenCalled();
      expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });

  test("Cancel leaves no seed behind and resets the fields", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull(),
    );
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    // A fresh open starts fresh: a cancelled create left nothing behind.
    await user.click(screen.getByRole("button", { name: "open" }));
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe("");
  });
});
