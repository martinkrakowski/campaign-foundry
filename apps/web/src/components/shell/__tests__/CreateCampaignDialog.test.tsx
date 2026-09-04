import { describe, test, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateCampaignProvider, useCreateCampaign } from "@/lib/create-campaign-context";
import { CREATE_SEED_KEY } from "@/lib/create-campaign";
import { ShellProviders, EMPTY_REPORT, json, mockPipelineApi, nextMock } from "@/__tests__/helpers";
import { editorReducer, initialEditorState, saveDraftToStorage } from "@/components/campaign/editor-state";
import * as messages from "@/components/campaign/messages";
import * as createCampaignLib from "@/lib/create-campaign";
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

  test("creating from a source duplicates with the dialog's overrides and lands on the copy — no seed, no baton", async () => {
    routeBriefs([classic], (url, init) => {
      expect(url).toBe("/api/pipeline/campaigns/briefs/summer-spark/duplicate");
      // The dialog's region and audience win over the source's; mode is not sent.
      expect(JSON.parse(String(init.body))).toEqual({
        newId: "summer-spark",
        overrides: { targetRegion: "EU", targetAudience: "trail runners" },
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

  test("a colliding name (a 409) keeps the dialog open with the duplicate-specific refusal", async () => {
    routeBriefs([classic], (url, init) => json({ error: 'Brief "summer-spark" already exists.' }, 409));
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
    routeBriefs([classic], (url, init) => json({ error: "fail" }, 500));
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
