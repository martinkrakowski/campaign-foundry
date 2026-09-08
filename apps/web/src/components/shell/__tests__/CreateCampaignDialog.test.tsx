import { describe, test, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CAMPAIGN_TYPES,
  CAMPAIGN_TYPE_PRESETS,
  DEFAULT_CAMPAIGN_TYPE,
} from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { CreateCampaignProvider, useCreateCampaign } from "@/lib/create-campaign-context";
import { CREATE_SEED_KEY } from "@/lib/create-campaign";
import { ShellProviders, json, mockPipelineApi, nextMock } from "@/__tests__/helpers";
import { editorReducer, initialEditorState, saveDraftToStorage } from "@/components/campaign/editor-state";
import { formatDisplayName, modeDisplayName, typeDisplayName } from "@/components/campaign/display-names";
import * as messages from "@/components/campaign/messages";
import * as createCampaignLib from "@/lib/create-campaign";
import { getFocusableDialogElements } from "@/components/ui";
import { CreateCampaignDialog } from "../CreateCampaignDialog";
import NewBriefPage from "@/app/(shell)/brief/new/page";

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
  return screen.findByRole("dialog", { name: messages.createCampaignTitle });
};

const fillValid = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");
};

const createDialog = () => screen.getByRole("dialog", { name: messages.createCampaignTitle });

beforeEach(() => {
  localStorage.clear();
  nextMock().nav.pathname = "/grid";
});

describe("CreateCampaignDialog", () => {
  test("the dialog renders exactly two controls: one text input and one three-tile group", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);

    expect(within(dialog).getAllByRole("textbox")).toHaveLength(1);
    const group = within(dialog).getByRole("group", { name: messages.createTypeLabel });
    expect(within(group).getAllByRole("button")).toHaveLength(3);
    expect(within(group).getAllByRole("button").map((tile) => tile.getAttribute("aria-label"))).toEqual([
      ...CAMPAIGN_TYPES,
    ]);
    expect(within(dialog).getAllByRole("status")).toHaveLength(1);
  });

  test("each type tile resolves by raw id, with the display words in textContent", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);

    for (const type of CAMPAIGN_TYPES) {
      const tile = within(dialog).getByRole("button", { name: type });
      expect(tile.getAttribute("aria-label")).toBe(type);
      expect(tile.textContent).toContain(typeDisplayName(type));
      expect(tile.textContent).toContain(modeDisplayName(CAMPAIGN_TYPE_PRESETS[type].mode));
      expect(tile.textContent).toContain(
        messages.typeTileGives(
          CAMPAIGN_TYPE_PRESETS[type].platforms.length,
          messages.joinList(CAMPAIGN_TYPE_PRESETS[type].formats.map((format) => formatDisplayName(format))),
        ),
      );
      expect(tile.textContent).not.toContain("static");
      expect(tile.textContent).not.toContain("motion");
    }
    expect(
      within(dialog).getByRole("button", { name: DEFAULT_CAMPAIGN_TYPE }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("the short-video tile says it runs as a Randomized campaign (D110)", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);
    const tile = within(dialog).getByRole("button", { name: "short-video" });
    expect(tile.textContent).toContain(messages.typeTileRunsAs(modeDisplayName("variation")));
  });

  test("each type tile's aria-describedby carries the display name, and short-video's carries the D110 sentence", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);

    for (const type of CAMPAIGN_TYPES) {
      const tile = within(dialog).getByRole("button", { name: type });
      const describedBy = tile.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      const target = document.getElementById(describedBy as string);
      expect(target?.textContent).toContain(typeDisplayName(type));
      if (type === "short-video") {
        expect(target?.textContent).toContain(messages.typeTileRunsAs(modeDisplayName("variation")));
      }
    }
  });

  test("Create with an empty name is refused in the status line, and the dialog stays open", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: messages.createCampaignConfirm }));

    expect(within(dialog).getAllByRole("status")).toHaveLength(1);
    expect(within(dialog).getByRole("status").textContent).toBe(messages.campaignNameRequired);
    expect(within(dialog).getByLabelText(messages.campaignNameLabel).getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
  });

  test("the dialog never shows the slug the name derives (D65)", async () => {
    const user = userEvent.setup();
    const { container } = renderDialog();
    await openDialog(user);
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");

    expect(container.textContent).not.toContain("summer-spark");
  });

  test("Create from elsewhere stashes the Identity step, closes the dialog, and pushes the seam's route", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new"));
    // D98: the landing branch belongs to the caller — off the blank route the baton
    // crosses the navigation this push causes, and it is Identity, not Copy: the
    // dialog no longer answers Identity, and both its fields are required by
    // `validateIdentity`.
    expect(localStorage.getItem("cf:step-handoff")).toBe("identity");
    expect(JSON.parse(localStorage.getItem(CREATE_SEED_KEY) as string)).toEqual({
      name: "Summer Spark",
      type: "social-post",
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull(),
    );
  });

  test("Create with no tile chosen stores type social-post", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new"));
    expect(JSON.parse(localStorage.getItem(CREATE_SEED_KEY) as string)).toEqual({
      name: "Summer Spark",
      type: "social-post",
    });
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

  test("choosing short-video stores { name, type: \"short-video\" } and the editor that consumes it is Randomized", async () => {
    const user = userEvent.setup();
    const view = renderDialog();
    const dialog = await openDialog(user);
    await fillValid(user);
    await user.click(within(dialog).getByRole("button", { name: "short-video" }));
    await user.click(within(dialog).getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new"));
    expect(JSON.parse(localStorage.getItem(CREATE_SEED_KEY) as string)).toEqual({
      name: "Summer Spark",
      type: "short-video",
    });
    view.unmount();

    localStorage.setItem("cf:brief-picked", "1");
    localStorage.removeItem("cf:presentation");
    mockPipelineApi({
      result: (url) =>
        String(url).includes("/campaigns/capabilities")
          ? json({ motion: true })
          : String(url).includes("/campaigns/briefs")
            ? json({ briefs: [] })
            : json({ halted: false, assets: [], log: null }),
    });
    nextMock().nav.pathname = "/brief/new";
    render(
      <ShellProviders>
        <CreateCampaignProvider>
          <NewBriefPage />
        </CreateCampaignProvider>
      </ShellProviders>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "Summer Spark",
      ),
    );
    expect(screen.getByRole("button", { name: "variation" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "brief" }).getAttribute("aria-pressed")).toBe("false");
  });

  test("a blocked store keeps the dialog open, says so, and neither navigates nor leaves a seed", async () => {
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const user = userEvent.setup();
    try {
      renderDialog();
      const dialog = await openDialog(user);
      await fillValid(user);
      await user.click(within(dialog).getByRole("button", { name: messages.createCampaignConfirm }));

      await waitFor(() =>
        expect(within(createDialog()).getByRole("status").textContent).toBe(
          messages.createCampaignBlocked,
        ),
      );
      expect(within(createDialog()).getAllByRole("status")).toHaveLength(1);
      expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
      expect(nextMock().router.push).not.toHaveBeenCalled();
      expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });

  test("Discard and close leaves no seed behind and resets the fields (D67, confirmed)", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");
    // D90: the typed work asks first — the guard rises in the footer…
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));
    expect(screen.getByText(messages.discardGuardTitle)).toBeTruthy();
    // …and Discard and close is the one control that completes the close.
    await user.click(screen.getByRole("button", { name: messages.discardGuardDiscardClose }));

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
    expect(localStorage.getItem("cf:step-handoff")).toBe("identity");
    // One gesture, one answer: the seed's publication must not re-ask.
    expect(screen.queryAllByRole("dialog", { name: messages.resumeDraftTitle })).toHaveLength(0);
  });

  test("two activations of Start over create once — the in-flight disable holds the second", async () => {
    stashAbandonedDraft();
    const user = userEvent.setup();
    // Hold the seam so the second press lands while `creating` is still true.
    // `setCreating(true)` runs in this click handler, so React flushes the
    // disabled re-render before the next click; a same-frame pair is the
    // overwrite-latch case, not this one.
    let release!: (value: { id: string; route: string }) => void;
    const held = new Promise<{ id: string; route: string }>((resolve) => {
      release = resolve;
    });
    const create = vi.spyOn(createCampaignLib, "createCampaign").mockReturnValue(held);

    renderDialog();
    const prompt = await raiseTwoWay(user);
    const startOver = within(prompt).getByRole("button", { name: messages.resumeDraftStartOver });
    await user.click(startOver);
    await user.click(startOver);

    expect(create).toHaveBeenCalledTimes(1);
    release({ id: "", route: "/brief/new" });
    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledTimes(1));
    expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new");
  });

  test("Start over with a blocked store shows the refusal on the form and publishes nothing", async () => {
    stashAbandonedDraft();
    const user = userEvent.setup();
    renderDialog();
    const prompt = await raiseTwoWay(user);

    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      await user.click(within(prompt).getByRole("button", { name: messages.resumeDraftStartOver }));

      await waitFor(() =>
        expect(within(createDialog()).getByRole("status").textContent).toBe(
          messages.createCampaignBlocked,
        ),
      );
      // The two-way must come down: the status line lives on the form it covers.
      expect(screen.queryByRole("dialog", { name: messages.resumeDraftTitle })).toBeNull();
      expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "Summer Spark",
      );
      expect(nextMock().router.push).not.toHaveBeenCalled();
      expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    } finally {
      setItem.mockRestore();
    }
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
    // The form's own Cancel now asks before discarding the typed work (D90 rewrote
    // this close path): the guard rises, and only Discard and close completes it.
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));
    expect(screen.getByText(messages.discardGuardTitle)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: messages.discardGuardDiscardClose }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: "open" }));
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: messages.resumeDraftTitle })).toBeNull();
  });

  test("the resume two-way and the discard guard never show together — the guard rides the footer the form keeps", async () => {
    stashAbandonedDraft();
    const user = userEvent.setup();
    renderDialog();
    await raiseTwoWay(user);

    // The two-way is up; the guard is not — the guard can only be raised from the
    // footer, and the footer's Create was the press that raised the two-way.
    expect(screen.queryByText(messages.discardGuardTitle)).toBeNull();

    // Escape takes the two-way down and raises no guard with it; the form's own
    // gestures are back afterwards, and a dirty Escape asks through the guard now.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: messages.resumeDraftTitle })).toBeNull();
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    expect(screen.queryByText(messages.discardGuardTitle)).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText(messages.discardGuardTitle)).toBeTruthy();
  });
});

describe("the inline discard guard (W2(a) / D90)", () => {
  test("an empty draft closes on the first Cancel — even a toggled type is not work, so a pristine dialog gains no confirmation", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    // The type tiles alone are never work in the draft: they have a default the
    // user may never have touched (D90).
    await user.click(screen.getByRole("button", { name: "short-video" }));
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull(),
    );
    expect(screen.queryByText(messages.discardGuardTitle)).toBeNull();
  });

  test("Escape closes an empty draft immediately too — the guard is for work, not for gestures", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull(),
    );
    expect(screen.queryByText(messages.discardGuardTitle)).toBeNull();
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
  });

  test("a dirty Cancel does not close — the guard asks in the footer and names what would be dropped", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));

    // The question replaces the row in place: same dialog, same scrim, form intact.
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    expect(screen.getByText(messages.discardGuardTitle)).toBeTruthy();
    expect(screen.getByText(messages.discardGuardDetail(true))).toBeTruthy();
    // The row it replaced is gone while it shows.
    expect(screen.queryByRole("button", { name: messages.confirmCancel })).toBeNull();
    expect(screen.queryByRole("button", { name: messages.createCampaignConfirm })).toBeNull();
    // Asking publishes nothing, and the guard adds no second live region.
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    expect(within(dialog).getAllByRole("status")).toHaveLength(1);
  });

  test("Keep editing restores the button row with the typed name intact", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));
    await user.click(screen.getByRole("button", { name: messages.discardGuardKeepEditing }));

    expect(screen.queryByText(messages.discardGuardTitle)).toBeNull();
    expect(screen.getByRole("button", { name: messages.confirmCancel })).toBeTruthy();
    expect(screen.getByRole("button", { name: messages.createCampaignConfirm })).toBeTruthy();
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
      "Summer Spark",
    );
  });

  test("Escape asks before discarding, and a second Escape keeps editing — Escape never destroys", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");
    fireEvent.keyDown(window, { key: "Escape" });

    // The first Escape raises the guard; the dialog and its answer stay.
    expect(screen.getByText(messages.discardGuardTitle)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
      "Summer Spark",
    );

    // The second Escape is Keep editing, never Discard: no keystroke sequence
    // can destroy a filled-in form.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText(messages.discardGuardTitle)).toBeNull();
    expect(screen.getByRole("button", { name: messages.confirmCancel })).toBeTruthy();
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
      "Summer Spark",
    );
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
  });

  test("the scrim asks on a dirty draft, and asks once — the second click keeps editing", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");
    // The scrim is the shell's own overlay, not a control — userEvent would land
    // the pointer on the panel, so the gesture is driven at the overlay itself
    // (fireEvent only where userEvent would refuse).
    fireEvent.click(screen.getByRole("dialog", { name: messages.createCampaignTitle }));
    expect(screen.getByText(messages.discardGuardTitle)).toBeTruthy();

    // While the guard shows, the same gesture is Keep editing, never Discard.
    fireEvent.click(screen.getByRole("dialog", { name: messages.createCampaignTitle }));
    expect(screen.queryByText(messages.discardGuardTitle)).toBeNull();
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
      "Summer Spark",
    );
  });

  test("opening the guard moves focus to its first answer; dismissing returns it to the control that raised it", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));

    // A guard nobody can reach by keyboard is not a guard: its first control
    // holds focus while it shows.
    expect(document.activeElement?.textContent).toBe(messages.discardGuardKeepEditing);

    // Dismissing hands focus back to the control that raised the guard.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(document.activeElement?.textContent).toBe(messages.confirmCancel);
  });

  test("clearing the last filled field while the guard shows dismisses it — a guard over nothing is the defect", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    const name = screen.getByLabelText(messages.campaignNameLabel);
    await user.type(name, "Summer Spark");
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));
    expect(screen.getByText(messages.discardGuardTitle)).toBeTruthy();

    await user.clear(name);

    // The empty-parts sentence is the defect; asserting it is gone is the
    // mutation target — remove the dismiss and this is what fails. HTML
    // collapses the two spaces `joinList([])` leaves, so the match is the
    // collapsed form.
    expect(
      screen.getByRole("dialog", { name: messages.createCampaignTitle }).textContent,
    ).not.toMatch(/Closing now discards\s+from this draft/);
    expect(screen.queryByText(messages.discardGuardTitle)).toBeNull();
    expect(screen.getByRole("button", { name: messages.confirmCancel })).toBeTruthy();
    expect(screen.getByRole("button", { name: messages.createCampaignConfirm })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe(messages.confirmCancel);
  });

  test("Keep editing restores focus to the name input when the raiser is still in the tree but disabled", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");
    const cancel = screen.getByRole("button", { name: messages.confirmCancel });
    await user.click(cancel);
    (cancel as HTMLButtonElement).disabled = true;
    await user.click(screen.getByRole("button", { name: messages.discardGuardKeepEditing }));

    expect(document.activeElement).toBe(screen.getByLabelText(messages.campaignNameLabel));
  });

  test("the head's Close asks on a dirty draft — the guard shows, the dialog stays", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");
    const dialog = screen.getByRole("dialog", { name: messages.createCampaignTitle });
    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    expect(screen.getByText(messages.discardGuardTitle)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
  });

  test("while the guard shows, Cancel and Create are out of the Tab cycle — Keep editing puts them back", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));

    const dialog = screen.getByRole("dialog", { name: messages.createCampaignTitle });
    const namesWhile = getFocusableDialogElements(dialog).map((el) => el.textContent);
    expect(namesWhile).not.toContain(messages.confirmCancel);
    expect(namesWhile).not.toContain(messages.createCampaignConfirm);

    await user.click(screen.getByRole("button", { name: messages.discardGuardKeepEditing }));
    const namesAfter = getFocusableDialogElements(dialog).map((el) => el.textContent);
    expect(namesAfter).toContain(messages.confirmCancel);
    expect(namesAfter).toContain(messages.createCampaignConfirm);
  });
});
