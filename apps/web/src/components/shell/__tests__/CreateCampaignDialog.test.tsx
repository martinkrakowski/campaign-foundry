import { describe, test, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CAMPAIGN_TYPES,
  CAMPAIGN_TYPE_PRESETS,
  DEFAULT_CAMPAIGN_TYPE,
} from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { CreateCampaignProvider, useCreateCampaign } from "@/lib/create-campaign-context";
import { campaignRoute } from "@/lib/campaign-route";
import { BriefsApiError } from "@/lib/briefs-api";
import { ShellProviders, nextMock } from "@/__tests__/helpers";
import {
  editorReducer,
  initialEditorState,
  saveDraftToStorage,
} from "@/components/campaign/editor-state";
import {
  formatDisplayName,
  modeDisplayName,
  typeDisplayName,
} from "@/components/campaign/display-names";
import * as messages from "@/components/campaign/messages";
import * as createCampaignLib from "@/lib/create-campaign";
import { getFocusableDialogElements } from "@/components/ui";
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
  test("the dialog renders exactly two controls: one text input and one four-tile group", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);

    expect(within(dialog).getAllByRole("textbox")).toHaveLength(1);
    const group = within(dialog).getByRole("group", { name: messages.createTypeLabel });
    expect(within(group).getAllByRole("button")).toHaveLength(4);
    expect(
      within(group)
        .getAllByRole("button")
        .map((tile) => tile.getAttribute("aria-label")),
    ).toEqual(["social-post", "paid-social", "short-video", "display-ad"]);
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
          messages.joinList(
            CAMPAIGN_TYPE_PRESETS[type].formats.map((format) => formatDisplayName(format)),
          ),
        ),
      );
      expect(tile.textContent).not.toContain("static");
      expect(tile.textContent).not.toContain("motion");
    }
    expect(
      within(dialog)
        .getByRole("button", { name: DEFAULT_CAMPAIGN_TYPE })
        .getAttribute("aria-pressed"),
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
        expect(target?.textContent).toContain(
          messages.typeTileRunsAs(modeDisplayName("variation")),
        );
      }
    }
  });

  test("nothing in the dialog is warning-coloured when nothing is wrong", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);

    // An empty dialog would satisfy "nothing is amber" vacuously, so the tiles
    // are counted first: the assertion below is about four tiles that exist.
    const group = within(dialog).getByRole("group", { name: messages.createTypeLabel });
    expect(within(group).getAllByRole("button")).toHaveLength(CAMPAIGN_TYPES.length);

    // `text-warning` is the kit's refusal colour. Nothing is refused here, so
    // the offender's own text is printed by the failure — on the unfixed tile
    // it is the tile's accessibility mirror, painted.
    const painted = Array.from(dialog.querySelectorAll("*"))
      .filter((element) => element.classList.contains("text-warning"))
      .map((element) => element.textContent);
    expect(painted).toEqual([]);
  });

  test("each tile's spoken description is an sr-only span, not a painted one", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);

    for (const type of CAMPAIGN_TYPES) {
      const tile = within(dialog).getByRole("button", { name: type });
      // One id, not a join: this tile carries a mirror and no gate reason.
      const ids = (tile.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
      expect(ids).toHaveLength(1);
      const target = document.getElementById(ids[0] as string);
      // An absent target must read as a failure, never as an empty pass.
      expect(target).not.toBeNull();
      // The facts are still there — deleting the text to silence the amber
      // would be a regression, and this is the half that catches it.
      expect(target?.textContent).toContain(typeDisplayName(type));
      expect(target?.textContent).toContain(
        messages.typeTileGives(
          CAMPAIGN_TYPE_PRESETS[type].platforms.length,
          messages.joinList(
            CAMPAIGN_TYPE_PRESETS[type].formats.map((format) => formatDisplayName(format)),
          ),
        ),
      );
      // happy-dom computes nothing from stylesheets, so "not visible" is
      // asserted as the class contract the house already uses for this
      // (world-map.test.tsx:329, swatch-picker.test.tsx:65) — `toBeVisible()`
      // here would assert nothing at all.
      expect(target?.classList.contains("sr-only")).toBe(true);
      expect(target?.classList.contains("text-warning")).toBe(false);
    }
  });

  test("the display-ad tile's description names the display placements (A5/D116)", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);
    const tile = within(dialog).getByRole("button", { name: "display-ad" });
    const target = document.getElementById(tile.getAttribute("aria-describedby") as string);
    expect(target?.textContent).toContain(
      "Runs on Google Display (HTML5) and Display web (HTML5).",
    );
    // The jargon gate: display words only — never a raw platform or format id.
    expect(target?.textContent).not.toContain("google-display");
    expect(target?.textContent).not.toContain("display-web");
    expect(target?.textContent).not.toContain("static");
  });

  test("Create with an empty name is refused in the status line, and the dialog stays open", async () => {
    const create = vi.spyOn(createCampaignLib, "createCampaign");
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: messages.createCampaignConfirm }));

    expect(within(dialog).getAllByRole("status")).toHaveLength(1);
    expect(within(dialog).getByRole("status").textContent).toBe(messages.campaignNameRequired);
    expect(
      within(dialog).getByLabelText(messages.campaignNameLabel).getAttribute("aria-invalid"),
    ).toBe("true");
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    // An invalid name never reaches the mint — nothing is created for nothing.
    expect(create).not.toHaveBeenCalled();
  });

  // PRRT_kwDOSzP1zc6m3XNB: `creating` is state, so it disables Create only after
  // a re-render. Both clicks are dispatched inside ONE `act`, so the first
  // click's `setCreating(true)` cannot disable the button before the second
  // lands. That is what exercises the synchronous latch itself.
  test("a double activation of Create mints only one campaign", async () => {
    let releaseMint!: () => void;
    const create = vi.spyOn(createCampaignLib, "createCampaign").mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseMint = () => resolve({ campaignId: "c-1" });
        }),
    );
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText(messages.campaignNameLabel), "Twice");
    const confirm = within(dialog).getByRole("button", { name: messages.createCampaignConfirm });

    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseMint();
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("the dialog never shows the slug the name derives (D65)", async () => {
    const user = userEvent.setup();
    const { container } = renderDialog();
    await openDialog(user);
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");

    expect(container.textContent).not.toContain("summer-spark");
  });

  test("Create posts the typed name and type, closes the dialog, and routes to the minted campaign (D177, D178)", async () => {
    const create = vi
      .spyOn(createCampaignLib, "createCampaign")
      .mockResolvedValue({ campaignId: "c1" });
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    expect(create).toHaveBeenCalledWith({ name: "Summer Spark", type: "social-post" });
    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith(campaignRoute("c1")));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull(),
    );
  });

  test("Create with no tile chosen stores type social-post", async () => {
    const create = vi
      .spyOn(createCampaignLib, "createCampaign")
      .mockResolvedValue({ campaignId: "c1" });
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith(campaignRoute("c1")));
    expect(create).toHaveBeenCalledWith({ name: "Summer Spark", type: "social-post" });
  });

  /**
   * PT-5c1 — the preset the type applies (Randomized/variation for
   * short-video, D109) is no longer something this dialog hands an editor
   * through a seed: `POST /campaigns` stores only `{ name, type }` server-side
   * (PT-5b3), and `/brief/<campaignId>` applies the type's preset itself from
   * `GET /campaigns/:id` (see `BriefEditor`'s own tests for that proof). This
   * dialog's job stops at sending the right type.
   */
  test('choosing short-video sends { name, type: "short-video" } to the mint', async () => {
    const create = vi
      .spyOn(createCampaignLib, "createCampaign")
      .mockResolvedValue({ campaignId: "c1" });
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);
    await fillValid(user);
    await user.click(within(dialog).getByRole("button", { name: "short-video" }));
    await user.click(within(dialog).getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith(campaignRoute("c1")));
    expect(create).toHaveBeenCalledWith({ name: "Summer Spark", type: "short-video" });
  });

  test('choosing display-ad sends { name, type: "display-ad" } to the mint', async () => {
    const create = vi
      .spyOn(createCampaignLib, "createCampaign")
      .mockResolvedValue({ campaignId: "c1" });
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);
    await fillValid(user);
    await user.click(within(dialog).getByRole("button", { name: "display-ad" }));
    await user.click(within(dialog).getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith(campaignRoute("c1")));
    expect(create).toHaveBeenCalledWith({ name: "Summer Spark", type: "display-ad" });
  });

  test("a refused mint keeps the dialog open, says so, and does not navigate", async () => {
    const create = vi
      .spyOn(createCampaignLib, "createCampaign")
      .mockRejectedValue(new BriefsApiError("Request failed (HTTP 500)", 500));
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);
    await fillValid(user);
    await user.click(within(dialog).getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() =>
      expect(within(createDialog()).getByRole("status").textContent).toBe(
        "Request failed (HTTP 500)",
      ),
    );
    expect(within(createDialog()).getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    expect(nextMock().router.push).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("Discard and close resets the fields — a cancelled create leaves nothing behind (D67, confirmed)", async () => {
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
      editorReducer(initialEditorState(), {
        type: "patch",
        patch: { campaignName: "Half-written" },
      }),
    );
  };

  const raiseTwoWay = async (user: ReturnType<typeof userEvent.setup>) => {
    await openDialog(user);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));
    return screen.findByRole("dialog", { name: messages.resumeDraftTitle });
  };

  test("a stale blank draft with no editor mounted asks before the mint proceeds", async () => {
    stashAbandonedDraft();
    const create = vi.spyOn(createCampaignLib, "createCampaign");
    const user = userEvent.setup();
    renderDialog();
    const prompt = await raiseTwoWay(user);

    expect(within(prompt).getByText(messages.resumeDraftQuestion)).toBeTruthy();
    // Asking mints nothing — the create is held until the user answers.
    expect(create).not.toHaveBeenCalled();
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("Resume mints nothing, keeps the draft, and lands on the blank route", async () => {
    stashAbandonedDraft();
    const create = vi.spyOn(createCampaignLib, "createCampaign");
    const user = userEvent.setup();
    renderDialog();
    const prompt = await raiseTwoWay(user);
    await user.click(within(prompt).getByRole("button", { name: messages.resumeDraftResume }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new"));
    expect(create).not.toHaveBeenCalled();
    // F19's whole point: the abandoned draft is exactly where it was, so the
    // recovery effect restores it untouched on the blank route.
    expect(localStorage.getItem("cf:draft:new")).not.toBeNull();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull(),
    );
  });

  test("Start over mints the campaign and proceeds — one prompt for the whole gesture", async () => {
    stashAbandonedDraft();
    const create = vi
      .spyOn(createCampaignLib, "createCampaign")
      .mockResolvedValue({ campaignId: "c1" });
    const user = userEvent.setup();
    renderDialog();
    const prompt = await raiseTwoWay(user);
    await user.click(within(prompt).getByRole("button", { name: messages.resumeDraftStartOver }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith(campaignRoute("c1")));
    expect(create).toHaveBeenCalledWith({ name: "Summer Spark", type: "social-post" });
    // One gesture, one answer: minting must not re-ask.
    expect(screen.queryAllByRole("dialog", { name: messages.resumeDraftTitle })).toHaveLength(0);
  });

  test("two activations of Start over create once — the in-flight disable holds the second", async () => {
    stashAbandonedDraft();
    const user = userEvent.setup();
    // Hold the seam so the second press lands while `creating` is still true.
    // `setCreating(true)` runs in this click handler, so React flushes the
    // disabled re-render before the next click; a same-frame pair is the
    // overwrite-latch case, not this one.
    let release!: (value: { campaignId: string }) => void;
    const held = new Promise<{ campaignId: string }>((resolve) => {
      release = resolve;
    });
    const create = vi.spyOn(createCampaignLib, "createCampaign").mockReturnValue(held);

    renderDialog();
    const prompt = await raiseTwoWay(user);
    const startOver = within(prompt).getByRole("button", { name: messages.resumeDraftStartOver });
    await user.click(startOver);
    await user.click(startOver);

    expect(create).toHaveBeenCalledTimes(1);
    release({ campaignId: "c1" });
    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledTimes(1));
    expect(nextMock().router.push).toHaveBeenCalledWith(campaignRoute("c1"));
  });

  test("Start over with a refused mint shows the refusal on the form and does not navigate", async () => {
    stashAbandonedDraft();
    const create = vi
      .spyOn(createCampaignLib, "createCampaign")
      .mockRejectedValue(new BriefsApiError("Request failed (HTTP 500)", 500));
    const user = userEvent.setup();
    renderDialog();
    const prompt = await raiseTwoWay(user);

    await user.click(within(prompt).getByRole("button", { name: messages.resumeDraftStartOver }));

    await waitFor(() =>
      expect(within(createDialog()).getByRole("status").textContent).toBe(
        "Request failed (HTTP 500)",
      ),
    );
    // The two-way must come down: the status line lives on the form it covers.
    expect(screen.queryByRole("dialog", { name: messages.resumeDraftTitle })).toBeNull();
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
      "Summer Spark",
    );
    expect(nextMock().router.push).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("a stored but pristine draft asks nothing — a pristine draft holds no work to lose", async () => {
    saveDraftToStorage(initialEditorState());
    vi.spyOn(createCampaignLib, "createCampaign").mockResolvedValue({ campaignId: "c1" });
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith(campaignRoute("c1")));
    expect(screen.queryAllByRole("dialog", { name: messages.resumeDraftTitle })).toHaveLength(0);
  });

  test("Escape and Cancel on the two-way return to the form and mint nothing; a reopened dialog starts at the form", async () => {
    stashAbandonedDraft();
    const create = vi.spyOn(createCampaignLib, "createCampaign");
    const user = userEvent.setup();
    renderDialog();
    await raiseTwoWay(user);
    fireEvent.keyDown(window, { key: "Escape" });

    // Back to the form, answers intact; nothing was minted, the draft untouched.
    expect(screen.queryByRole("dialog", { name: messages.resumeDraftTitle })).toBeNull();
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
      "Summer Spark",
    );
    expect(create).not.toHaveBeenCalled();
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
  });

  test("a dirty Cancel does not close — the guard asks in the footer and names what would be dropped", async () => {
    const create = vi.spyOn(createCampaignLib, "createCampaign");
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
    // Asking mints nothing, and the guard adds no second live region.
    expect(create).not.toHaveBeenCalled();
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

describe("CC6 — three tile groups, named for what the user is making (D162)", () => {
  test("each group exposes an accessible name, and each tile appears under the correct one", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);

    const stillGroup = within(dialog).getByRole("group", { name: messages.typeGroupStillImage });
    expect(
      within(stillGroup)
        .getAllByRole("button")
        .map((tile) => tile.getAttribute("aria-label")),
    ).toEqual(["social-post", "paid-social"]);

    const videoGroup = within(dialog).getByRole("group", { name: messages.typeGroupVideo });
    expect(
      within(videoGroup)
        .getAllByRole("button")
        .map((tile) => tile.getAttribute("aria-label")),
    ).toEqual(["short-video"]);

    const htmlGroup = within(dialog).getByRole("group", { name: messages.typeGroupHtmlAd });
    expect(
      within(htmlGroup)
        .getAllByRole("button")
        .map((tile) => tile.getAttribute("aria-label")),
    ).toEqual(["display-ad"]);
  });

  test("all four types remain reachable and selectable, iterating CAMPAIGN_TYPES", async () => {
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);

    for (const type of CAMPAIGN_TYPES) {
      const tile = within(dialog).getByRole("button", { name: type });
      await user.click(tile);
      expect(tile.getAttribute("aria-pressed")).toBe("true");
    }
  });

  /**
   * PT-5c1 — which preset mode the type produces is now BriefEditor's own
   * proof (it applies the preset from `GET /campaigns/:id`'s `type`, not
   * from anything this dialog hands it). This dialog's contract stops at
   * sending the one selected type to the mint.
   */
  test("selecting short-video sends type short-video, not the earlier tile in another group", async () => {
    const create = vi
      .spyOn(createCampaignLib, "createCampaign")
      .mockResolvedValue({ campaignId: "c1" });
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);
    await fillValid(user);
    await user.click(within(dialog).getByRole("button", { name: "short-video" }));
    await user.click(within(dialog).getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith(campaignRoute("c1")));
    expect(create).toHaveBeenCalledWith({ name: "Summer Spark", type: "short-video" });
  });

  test("selecting a static type sends that type", async () => {
    const create = vi
      .spyOn(createCampaignLib, "createCampaign")
      .mockResolvedValue({ campaignId: "c1" });
    const user = userEvent.setup();
    renderDialog();
    const dialog = await openDialog(user);
    await fillValid(user);
    await user.click(within(dialog).getByRole("button", { name: "display-ad" }));
    await user.click(within(dialog).getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith(campaignRoute("c1")));
    expect(create).toHaveBeenCalledWith({ name: "Summer Spark", type: "display-ad" });
  });

  test("selecting across groups sends only the last-selected type — the mint runs once per Create", async () => {
    const user = userEvent.setup();
    const createSpy = vi
      .spyOn(createCampaignLib, "createCampaign")
      .mockResolvedValue({ campaignId: "c1" });
    renderDialog();
    const dialog = await openDialog(user);
    await fillValid(user);

    // Select in static group then in motion group
    await user.click(within(dialog).getByRole("button", { name: "paid-social" }));
    await user.click(within(dialog).getByRole("button", { name: "short-video" }));
    await user.click(within(dialog).getByRole("button", { name: messages.createCampaignConfirm }));

    // The mint runs once, for the single selected type.
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledWith({
      name: "Summer Spark",
      type: "short-video",
    });
    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith(campaignRoute("c1")));
  });
});
