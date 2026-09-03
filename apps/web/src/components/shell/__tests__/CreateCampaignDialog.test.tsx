import { describe, test, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateCampaignProvider, useCreateCampaign } from "@/lib/create-campaign-context";
import { CREATE_SEED_KEY } from "@/lib/create-campaign";
import { ShellProviders, nextMock } from "@/__tests__/helpers";
import { editorReducer, initialEditorState, saveDraftToStorage } from "@/components/campaign/editor-state";
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

/** W3: the dialog reads `isDirty` from the guard's provider — the same tree the
 *  shell layout builds (the shared helper supplies EditorDirtyProvider). */
const renderDialog = () =>
  render(
    <ShellProviders>
      <CreateCampaignProvider>
        <Harness />
      </CreateCampaignProvider>
    </ShellProviders>,
  );

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

describe("the abandoned-draft two-way (W3 / F19)", () => {
  /**
   * The abandoned draft, written the way the editor's autosave effect does: a
   * non-pristine editor state under the blank route's one stable key (H6).
   */
  const stashAbandonedDraft = () => {
    saveDraftToStorage(
      editorReducer(initialEditorState(), { type: "patch", patch: { campaignName: "Half-written" } }),
    );
  };

  const raiseTwoWay = async (user: ReturnType<typeof userEvent.setup>) => {
    await openDialog(user);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));
    return screen.findByRole("dialog", { name: messages.resumeDraftTitle });
  };

  test("a stale blank draft with no editor mounted asks before the seed overwrites it", async () => {
    stashAbandonedDraft();
    const user = userEvent.setup();
    renderDialog();
    const prompt = await raiseTwoWay(user);

    expect(within(prompt).getByText(messages.resumeDraftQuestion)).toBeTruthy();
    // Asking publishes nothing — the create is held until the user answers.
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("Resume publishes no seed, keeps the draft, and lands on the blank route without the baton", async () => {
    stashAbandonedDraft();
    const user = userEvent.setup();
    renderDialog();
    const prompt = await raiseTwoWay(user);
    await user.click(within(prompt).getByRole("button", { name: messages.resumeDraftResume }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new"));
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    // F19's whole point: the abandoned draft is exactly where it was, so the
    // recovery effect restores it untouched on the blank route.
    expect(localStorage.getItem("cf:draft:new")).not.toBeNull();
    // And never the step baton: the restored draft resumes where the user left
    // off, not on Copy.
    expect(localStorage.getItem("cf:step-handoff")).toBeNull();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull(),
    );
  });

  test("Start over publishes the seed and proceeds — one prompt for the whole gesture", async () => {
    stashAbandonedDraft();
    const user = userEvent.setup();
    renderDialog();
    const prompt = await raiseTwoWay(user);
    await user.click(within(prompt).getByRole("button", { name: messages.resumeDraftStartOver }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new"));
    expect(JSON.parse(localStorage.getItem(CREATE_SEED_KEY) as string).name).toBe("Summer Spark");
    expect(localStorage.getItem("cf:step-handoff")).toBe("copy");
    // One gesture, one answer: the seed's publication must not re-ask.
    expect(screen.queryAllByRole("dialog", { name: messages.resumeDraftTitle })).toHaveLength(0);
  });

  test("a stored but pristine draft asks nothing — a pristine draft holds no work to lose", async () => {
    saveDraftToStorage(initialEditorState());
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new"));
    expect(screen.queryAllByRole("dialog", { name: messages.resumeDraftTitle })).toHaveLength(0);
  });

  test("Escape and Cancel on the two-way return to the form and publish nothing; a reopened dialog starts at the form", async () => {
    stashAbandonedDraft();
    const user = userEvent.setup();
    renderDialog();
    await raiseTwoWay(user);
    fireEvent.keyDown(window, { key: "Escape" });

    // Back to the form, answers intact; nothing was published, the draft untouched.
    expect(screen.queryByRole("dialog", { name: messages.resumeDraftTitle })).toBeNull();
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe("Summer Spark");
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    expect(localStorage.getItem("cf:draft:new")).not.toBeNull();

    // Cancel dismisses the same way — and the two-way raises again on a fresh
    // press, because the dismissed prompt state was cleared, not left open.
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));
    await user.click(
      within(await screen.findByRole("dialog", { name: messages.resumeDraftTitle })).getByRole(
        "button",
        { name: messages.confirmCancel },
      ),
    );
    expect(screen.queryByRole("dialog", { name: messages.resumeDraftTitle })).toBeNull();
    // The form's own Cancel then closes everything; a reopened dialog starts at
    // the form, never mid-prompt.
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: "open" }));
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: messages.resumeDraftTitle })).toBeNull();
  });
});
