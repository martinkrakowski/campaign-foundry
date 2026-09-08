import { describe, test, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateCampaignProvider, useCreateCampaign } from "@/lib/create-campaign-context";
import { CREATE_SEED_KEY } from "@/lib/create-campaign";
import { ShellProviders, EMPTY_REPORT, json, mockPipelineApi, nextMock } from "@/__tests__/helpers";
import { editorReducer, initialEditorState, saveDraftToStorage } from "@/components/campaign/editor-state";
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
  test("collects the five things the Identity step decides (D86), in three numbered sections, with Classic preselected", async () => {
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
    // The three numbered sections, under the dialog's h2 — sibling h3s, never h2s.
    // DOM order and numerals are the structure D86 specifies: start-from precedes
    // mode because choosing a source replaces the mode control with a readout.
    const headings = screen.getAllByRole("heading", { level: 3 });
    expect(
      headings.map((h) => {
        const numeral = h.querySelector("span[aria-hidden='true']")?.textContent ?? "";
        const title =
          [...h.querySelectorAll("span")].find((s) => s.getAttribute("aria-hidden") !== "true")
            ?.textContent ?? "";
        return `${numeral} · ${title}`;
      }),
    ).toEqual([
      `01 · ${messages.createSectionTargeting}`,
      `02 · ${messages.createSectionStartFrom}`,
      `03 · ${messages.createSectionMode}`,
    ]);
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
    expect(screen.getByLabelText(messages.campaignNameLabel).getAttribute("aria-invalid")).toBe(
      "true",
    );
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

  test("a refused create marks every missing field in place while the status line still names only the first (D91)", async () => {
    const user = userEvent.setup();
    const { container } = renderDialog();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    // Exactly one live region, however many fields are missing — and it stays
    // first-missing-wins, speaking today's sentence and nothing more.
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe(messages.campaignNameRequired);

    // Every missing field is marked in its own slot, not only the first.
    const fieldText = (key: string) =>
      container.querySelector(`[data-field-key="${key}"]`)!.textContent!;
    expect(fieldText("campaignName")).toContain(messages.campaignNameRequired);
    expect(fieldText("targetRegion")).toContain(messages.targetRegion);
    expect(fieldText("targetAudience")).toContain(messages.targetAudience);
    expect(screen.getByLabelText(messages.targetAudienceLabel).getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(screen.getByLabelText(messages.targetRegionLabel).getAttribute("aria-invalid")).toBe(
      "true",
    );

    // One chip per mark in the footer strip.
    expect(screen.getByRole("button", { name: "Campaign Name 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Target Region 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Target Audience 1" })).toBeTruthy();
  });

  test("a footer chip jumps to the section the marked field lives in", async () => {
    const user = userEvent.setup();
    const { container } = renderDialog();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));
    const identity = container.querySelector<HTMLElement>('[data-create-section="identity"]')!;
    const targeting = container.querySelector<HTMLElement>('[data-create-section="targeting"]')!;
    identity.scrollIntoView = vi.fn();
    targeting.scrollIntoView = vi.fn();

    // The name mark jumps to the identity strip; the region mark, to `01 · Targeting`.
    await user.click(screen.getByRole("button", { name: "Campaign Name 1" }));
    expect(identity.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(targeting.scrollIntoView).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Target Region 1" }));
    expect(targeting.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  test("a chip's jump respects prefers-reduced-motion (D28)", async () => {
    const matchMedia = vi
      .spyOn(window, "matchMedia")
      .mockReturnValue({
        matches: true,
        media: "(prefers-reduced-motion: reduce)",
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => false,
      } as MediaQueryList);
    try {
      const user = userEvent.setup();
      const { container } = renderDialog();
      await openDialog(user);
      await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));
      const identity = container.querySelector<HTMLElement>('[data-create-section="identity"]')!;
      identity.scrollIntoView = vi.fn();
      await user.click(screen.getByRole("button", { name: "Campaign Name 1" }));

      expect(identity.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    } finally {
      matchMedia.mockRestore();
    }
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
    // D108 — the seed carries the name and the campaign type. The dialog's mode
    // panel is the T2 bridge (Randomized maps to paid-social); T3 replaces it
    // with the type field itself.
    expect(JSON.parse(localStorage.getItem(CREATE_SEED_KEY) as string)).toEqual({
      name: "Summer Spark",
      type: "social-post",
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

  test("the mode choice rides the seed as its bridged campaign type", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: "variation" }));
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new"));
    // The T2 bridge: Randomized maps to the paid-social type until T3's field.
    expect(JSON.parse(localStorage.getItem(CREATE_SEED_KEY) as string).type).toBe("paid-social");
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

      expect(await screen.findByRole("status")).toBeTruthy();
      expect(screen.getByRole("status").textContent).toBe(messages.createCampaignBlocked);
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

describe("start from an existing campaign (W2 / D71)", () => {
  /** The classic and randomized rows the source list offers, in listBriefs' shape. */
  const classic = { file: "summer-spark.yaml", brief: { id: "summer-spark", targetRegion: "EU", products: [{ id: "a" }] } };
  const randomized = {
    file: "winter-wild.yaml",
    brief: { id: "winter-wild", mode: "variation", targetRegion: "DE", products: [{ id: "a" }] },
  };
  const copy = { id: "summer-spark", targetRegion: "EU", products: [{ id: "a" }] };

  const routeBriefs = (
    briefs: unknown[],
    post?: (url: string, init: RequestInit) => Response,
  ) =>
    mockPipelineApi({
      post: (url, init) => (post ? post(url, init) : json({ jobId: "job-1" }, 202)),
      result: (url) => (url.includes("/campaigns/briefs") ? json({ briefs }) : json(EMPTY_REPORT)),
    });

  const chooseSource = async (user: ReturnType<typeof userEvent.setup>, id = "summer-spark") => {
    await user.click(await screen.findByText(id));
  };

  test("the source list renders the store's briefs inside the dialog, with the picker's row shape", async () => {
    routeBriefs([classic, randomized]);
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    expect(await screen.findByText("winter-wild")).toBeTruthy();
    expect(
      screen.getByText(messages.startFromRowMeta(1, 1, "EU")),
    ).toBeTruthy();
    // The blank default row rests selected: a blank create is the common case.
    expect(
      screen
        .getByRole("button", { name: messages.startFromExistingBlank })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("an empty store shows the empty state — this create will be the first", async () => {
    routeBriefs([]);
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    expect(await screen.findByText(messages.startFromExistingEmpty)).toBeTruthy();
  });

  test("a failed list shows the error state, not a misleading empty one", async () => {
    mockPipelineApi({
      result: (url) => (url.includes("/campaigns/briefs") ? json({ error: "fail" }, 500) : json(EMPTY_REPORT)),
    });
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    expect(await screen.findByText(messages.startFromExistingError)).toBeTruthy();
  });

  test("creating from a source duplicates and lands on the copy — no seed, no baton, no overrides", async () => {
    routeBriefs([classic], (url, init) => {
      expect(url).toBe("/api/pipeline/campaigns/briefs/summer-spark/duplicate");
      // D97 — the dialog answers no Identity field, so the overrides body is
      // empty: the copy inherits the source's answers. Mode is not sent either
      // (the route refuses it; the copy inherits the source's mode).
      expect(JSON.parse(String(init.body))).toEqual({
        newId: "summer-spark",
        overrides: {},
      });
      return json({ file: "summer-spark.yaml", brief: copy }, 201);
    });
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await chooseSource(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief/summer-spark"));
    // The dialog never builds a URL itself — the seam's route is what it pushes.
    expect(nextMock().router.push).toHaveBeenCalledTimes(1);
    // The source path publishes no seed and stashes no baton: the seed is spent
    // only by a mounted editor on the blank route, and /brief/summer-spark has none.
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    expect(localStorage.getItem("cf:step-handoff")).toBeNull();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull(),
    );
  });

  test("the mode field reads the inherited mode while a source is chosen, and deselecting restores the toggle", async () => {
    routeBriefs([randomized]);
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    // Without a source: the live mode cards.
    expect(screen.getByRole("button", { name: "brief" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "variation" })).toBeTruthy();

    await chooseSource(user, "winter-wild");
    // Not a disabled control — a sentence: the copy inherits the source's mode and
    // the wizard can change it. The dead cards are gone entirely.
    expect(screen.getByText(messages.createModeInherited("Randomized"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: "brief" })).toBeNull();
    expect(screen.queryByRole("button", { name: "variation" })).toBeNull();

    await user.click(screen.getByRole("button", { name: messages.startFromExistingBlank }));
    expect(screen.queryByText(messages.createModeInherited("Randomized"))).toBeNull();
    expect(screen.getByRole("button", { name: "brief" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "variation" })).toBeTruthy();
  });

  test("a Classic source reads Classic in the inherited-mode readout", async () => {
    routeBriefs([classic]);
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    // A source with no mode of its own defaults to brief — the readout says so
    // through the one display-name map, not a second ternary here.
    await chooseSource(user, "summer-spark");
    expect(screen.getByText(messages.createModeInherited("Classic"))).toBeTruthy();
  });

  test("a colliding name (a 409) keeps the dialog open with the duplicate-specific refusal", async () => {
    routeBriefs([classic], () => json({ error: 'Brief "summer-spark" already exists.' }, 409));
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await chooseSource(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    // Not the storage story: a 409 is the API's answer, so it gets its own sentence.
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(messages.createCampaignDuplicateConflict);
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    expect(nextMock().router.push).not.toHaveBeenCalled();
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    // The typed answers survive for a retry.
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe("Summer Spark");
  });

  test("any other refused duplicate (a 500) answers with the retry sentence, not the storage one", async () => {
    routeBriefs([classic], () => json({ error: "fail" }, 500));
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await chooseSource(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(messages.createCampaignDuplicateFailed);
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("a name with no letters or numbers is refused before the request when a source is chosen", async () => {
    const post = vi.fn((_url: string, _init: RequestInit) => json({ file: "summer-spark.yaml", brief: copy }, 201));
    routeBriefs([classic], (url, init) => post(url, init));
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    // The form's empty-name refusal passes ("!!!" is not empty), and the copy's
    // own name would derive to nothing — refused here, before the request.
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "!!!");
    await user.click(screen.getByRole("button", { name: "EU" }));
    await user.type(screen.getByLabelText(messages.targetAudienceLabel), "trail runners");
    await chooseSource(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(messages.campaignNameNotSluggable);
    // Same field, same treatment as the empty-name refusal: error border + aria-invalid.
    expect(screen.getByLabelText(messages.campaignNameLabel).getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(post).not.toHaveBeenCalled();
    expect(nextMock().router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
  });

  test("the W3 two-way does not fire when a source is chosen — the draft is not at risk", async () => {
    saveDraftToStorage(
      editorReducer(initialEditorState(), { type: "patch", patch: { campaignName: "Half-written" } }),
    );
    const post = vi.fn((_url: string, _init: RequestInit) => json({ file: "summer-spark.yaml", brief: copy }, 201));
    routeBriefs([classic], (url, init) => post(url, init));
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await chooseSource(user);
    await user.click(screen.getByRole("button", { name: messages.createCampaignConfirm }));

    // No prompt, straight through: the source path publishes no seed, so the
    // abandoned draft is not at risk — and the prompt's two answers would both lie.
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(screen.queryByRole("dialog", { name: messages.resumeDraftTitle })).toBeNull();
    await waitFor(() => expect(nextMock().router.push).toHaveBeenCalledWith("/brief/summer-spark"));
    // The draft the blank path would have asked about is exactly where it was.
    expect(localStorage.getItem("cf:draft:new")).not.toBeNull();
  });
});

describe("the inline discard guard (W2(a) / D90)", () => {
  /** The store's one brief, for the chosen-source cases; listBriefs' row shape. */
  const classic = { file: "summer-spark.yaml", brief: { id: "summer-spark", targetRegion: "EU", products: [{ id: "a" }] } };
  const routeBriefs = (briefs: unknown[]) =>
    mockPipelineApi({
      result: (url: string) =>
        url.includes("/campaigns/briefs") ? json({ briefs }) : json(EMPTY_REPORT),
    });

  test("an empty draft closes on the first Cancel — even a toggled mode is not work, so a pristine dialog gains no confirmation", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    // The mode toggle alone is never work in the draft: it has a default the
    // user may never have touched (D90).
    await user.click(screen.getByRole("button", { name: "variation" }));
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
    await openDialog(user);
    await fillValid(user);
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));

    // The question replaces the row in place: same dialog, same scrim, form intact.
    expect(screen.getByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    expect(screen.getByText(messages.discardGuardTitle)).toBeTruthy();
    expect(
      screen.getByText("Closing now discards a name, a region and an audience from this draft."),
    ).toBeTruthy();
    // The row it replaced is gone while it shows.
    expect(screen.queryByRole("button", { name: messages.confirmCancel })).toBeNull();
    expect(screen.queryByRole("button", { name: messages.createCampaignConfirm })).toBeNull();
    // Asking publishes nothing, and the guard adds no second live region (D91).
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("the guard's detail names only what is filled in — a half-answered draft is named half-answered", async () => {
    const user = userEvent.setup();
    // A name alone…
    const first = renderDialog();
    await openDialog(user);
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "Summer Spark");
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));
    expect(screen.getByText("Closing now discards a name from this draft.")).toBeTruthy();
    first.unmount();

    // …a region alone…
    const second = renderDialog();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "EU" }));
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));
    expect(screen.getByText("Closing now discards a region from this draft.")).toBeTruthy();
    second.unmount();

    // …an audience alone: each answer is named when it exists and never otherwise.
    renderDialog();
    await openDialog(user);
    await user.type(screen.getByLabelText(messages.targetAudienceLabel), "trail runners");
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));
    expect(screen.getByText("Closing now discards an audience from this draft.")).toBeTruthy();
  });

  test("a chosen source alone is work in the draft — the guard asks and names it", async () => {
    routeBriefs([classic]);
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await user.click(await screen.findByText("summer-spark"));
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));

    expect(screen.getByText(messages.discardGuardTitle)).toBeTruthy();
    expect(screen.getByText("Closing now discards a chosen source from this draft.")).toBeTruthy();
  });

  test("a draft with every answer filled is named in full — the sentence lists all four", async () => {
    routeBriefs([classic]);
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await fillValid(user);
    await user.click(await screen.findByText("summer-spark"));
    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));

    expect(
      screen.getByText(
        "Closing now discards a name, a region, an audience and a chosen source from this draft.",
      ),
    ).toBeTruthy();
  });

  test("Keep editing restores the button row with every typed answer intact", async () => {
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
    expect(screen.getByRole("button", { name: "EU" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText(messages.targetAudienceLabel) as HTMLInputElement).value).toBe(
      "trail runners",
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

  test("Keep editing restores focus to the name input when the raiser has unmounted", async () => {
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: messages.targetRegionOther }));
    const other = screen.getByLabelText(messages.targetRegionOtherInputLabel);
    await user.type(other, "LATAM");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText(messages.discardGuardTitle)).toBeTruthy();

    // A preset chip unmounts the Other… input — the raiser is now detached.
    await user.click(screen.getByRole("button", { name: "EU" }));
    await user.click(screen.getByRole("button", { name: messages.discardGuardKeepEditing }));

    expect(document.activeElement).toBe(screen.getByLabelText(messages.campaignNameLabel));
    expect(document.activeElement).not.toBe(document.body);
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

describe("the map in 01 · Targeting (M2 / D94)", () => {
  /** The store's briefs, for the rail's eyebrow count; listBriefs' row shape. */
  const classic = { file: "summer-spark.yaml", brief: { id: "summer-spark", targetRegion: "EU", products: [{ id: "a" }] } };
  const randomized = {
    file: "winter-wild.yaml",
    brief: { id: "winter-wild", mode: "variation", targetRegion: "DE", products: [{ id: "a" }] },
  };
  const routeBriefs = (briefs: unknown[]) =>
    mockPipelineApi({
      result: (url: string) =>
        url.includes("/campaigns/briefs") ? json({ briefs }) : json(EMPTY_REPORT),
    });

  test("clicking a footprint sets the region exactly as its chip does — the two are one control", async () => {
    const user = userEvent.setup();
    const { container } = renderDialog();
    await openDialog(user);
    const eu = container.querySelector('[data-region="EU"]') as SVGGElement;
    fireEvent.click(eu);

    expect(screen.getByRole("button", { name: "EU" }).getAttribute("aria-pressed")).toBe("true");
    // And the value itself is `EU` — the mirror input carries it to the seed.
    expect((screen.getByLabelText(messages.targetRegionLabel) as HTMLInputElement).value).toBe("EU");
  });

  test("a map pick after Other… selects that chip and closes the custom input", async () => {
    const user = userEvent.setup();
    const { container } = renderDialog();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: messages.targetRegionOther }));
    expect(screen.getByLabelText(messages.targetRegionOtherInputLabel)).toBeTruthy();

    fireEvent.click(container.querySelector('[data-region="DE"]') as SVGGElement);

    expect(screen.getByRole("button", { name: "DE" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByLabelText(messages.targetRegionOtherInputLabel)).toBeNull();
  });

  test("clicking a chip paints its footprint — the map reads the same value", async () => {
    const user = userEvent.setup();
    const { container } = renderDialog();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "DE" }));

    const selected = container.querySelectorAll("[data-selected]");
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute("data-region")).toBe("DE");
  });

  test("Other… paints no footprint, and a typed custom region keeps the map clear", async () => {
    const user = userEvent.setup();
    const { container } = renderDialog();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: messages.targetRegionOther }));
    expect(container.querySelectorAll("[data-selected]")).toHaveLength(0);

    const other = screen.getByLabelText(messages.targetRegionOtherInputLabel);
    await user.type(other, "LATAM");
    expect((screen.getByLabelText(messages.targetRegionLabel) as HTMLInputElement).value).toBe("LATAM");
    expect(container.querySelectorAll("[data-selected]")).toHaveLength(0);
  });

  test("the map's hint is written against F2 — it names what the region shapes, and never a per-region dispatch", async () => {
    const user = userEvent.setup();
    const { container } = renderDialog();
    await openDialog(user);

    const hint = screen.getByText(messages.worldMapRegionHint);
    expect(hint.textContent).toBe("The region shapes the generated backgrounds and copy.");
    // The mockup's sentence — "runs dispatch per region" — describes a product
    // this is not (F2); the hint may never say it.
    expect(hint.textContent).not.toMatch(/dispatch|per region|\brun/i);
    // The sr-only fallback points at the chips (D94), and the map adds no live
    // region of its own — the dialog's one `role="status"` split is untouched.
    expect(container.querySelector("p.sr-only")?.textContent).toBe(messages.worldMapFallbackHint);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  test("the map is aria-hidden chrome: no focusable in the Tab cycle comes from the SVG", async () => {
    const user = userEvent.setup();
    const { container } = renderDialog();
    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "EU" }));

    const dialog = screen.getByRole("dialog", { name: messages.createCampaignTitle });
    // The dialog carries other decorative SVGs (mode glyphs); the map's is the
    // one painting the footprints.
    const svg = (container.querySelector('[data-region="EU"]') as SVGGElement).closest(
      "svg",
    ) as SVGSVGElement;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    const focusables = getFocusableDialogElements(dialog);
    expect(focusables.length).toBeGreaterThan(0);
    for (const el of focusables) {
      expect(el.closest("svg")).toBeNull();
    }
    // D96/D88 — selection paints the map, but nothing in the dialog loops.
    for (const el of dialog.querySelectorAll("*")) {
      for (const cls of Array.from(el.classList)) {
        expect(cls.startsWith("animate-")).toBe(false);
      }
    }
  });

  test("the rail's eyebrow counts the campaigns, both plural arms", async () => {
    routeBriefs([classic, randomized]);
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    expect(await screen.findByText(messages.startFromCampaignCount(2))).toBeTruthy();
  });

  test("one campaign reads singular", async () => {
    routeBriefs([classic]);
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    expect(await screen.findByText(messages.startFromCampaignCount(1))).toBeTruthy();
  });

  test("a failed read leaves the eyebrow down — the picker's error sentence is the story", async () => {
    mockPipelineApi({
      result: (url: string) =>
        url.includes("/campaigns/briefs") ? json({ error: "fail" }, 500) : json(EMPTY_REPORT),
    });
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    expect(await screen.findByText(messages.startFromExistingError)).toBeTruthy();
    expect(screen.queryByText(messages.startFromCampaignCount(0))).toBeNull();
  });

  test("the rail's count comes from the picker's own list — one listing per open", async () => {
    routeBriefs([classic, randomized]);
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);

    expect(await screen.findByText(messages.startFromCampaignCount(2))).toBeTruthy();
    const briefsCalls = vi.mocked(globalThis.fetch).mock.calls.filter(([url]) =>
      String(url).includes("/campaigns/briefs"),
    );
    expect(briefsCalls).toHaveLength(1);
  });

  test("a close clears the count — a reopen does not flash the previous number", async () => {
    routeBriefs([classic, randomized]);
    const user = userEvent.setup();
    renderDialog();
    await openDialog(user);
    expect(await screen.findByText(messages.startFromCampaignCount(2))).toBeTruthy();

    await user.click(screen.getByRole("button", { name: messages.confirmCancel }));
    expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull();

    let release!: () => void;
    const held = new Promise<Response>((resolve) => {
      release = () => resolve(json({ briefs: [classic, randomized] }));
    });
    mockPipelineApi({
      result: (url: string) =>
        url.includes("/campaigns/briefs") ? held : json(EMPTY_REPORT),
    });
    await user.click(screen.getByRole("button", { name: "open" }));
    await screen.findByRole("dialog", { name: messages.createCampaignTitle });
    expect(screen.queryByText(messages.startFromCampaignCount(2))).toBeNull();
    expect(screen.getByText(messages.startFromExistingLoading)).toBeTruthy();
    release();
    expect(await screen.findByText(messages.startFromCampaignCount(2))).toBeTruthy();
  });
});
