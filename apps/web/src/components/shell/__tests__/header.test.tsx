import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, within, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, useEffect, useRef, type ReactElement } from "react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { nextMock, renderWithRun, ShellProviders, jobOk, mockPipelineApi } from "@/__tests__/helpers";
import { useEditorDirty } from "@/lib/editor-dirty-context";
import { useRun } from "@/lib/run-context";
import {
  generateNoBrief,
  generateDraftTitle,
  generateDraftRunThis,
  generateDraftSaveRun,
  modelChanged,
  telemetryButton,
} from "@/components/campaign/messages";
import { Header } from "../Header";

// The theme toggle writes to <html>, which is shared by every test in this file and is
// not the element `cleanup()` unmounts — the next test would inherit a light theme.
afterEach(() => {
  document.documentElement.classList.add("dark");
  localStorage.clear();
});

/** Raises the editor's dirty flag, so any guarded navigation has to prompt. */
const RaiseDirty = () => {
  const { setDirty } = useEditorDirty();
  useEffect(() => setDirty(true), [setDirty]);
  return null;
};

const renderDirty = (ui: ReactElement) =>
  render(createElement(ShellProviders, null, createElement(RaiseDirty), ui));

/** Commits a brief the way Apply does — the one thing that turns Generate into a run. */
const ApplyBrief = () => {
  const { brief, setBrief } = useRun();
  return (
    <button type="button" onClick={() => setBrief({ ...brief, id: "applied-brief" })}>
      apply
    </button>
  );
};

/** POSTs to the generate endpoint — the proof that a run really was started. */
const generatePosts = () =>
  vi.mocked(globalThis.fetch).mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "POST",
  );

describe("Header", () => {
  test("the mobile menu trigger is a 32px icon control, named and marked as a popup", () => {
    renderWithRun(<Header />);

    // Its name is a contract: the suite and the mobile menu's own tests reach the
    // trigger by "Open menu", and an icon-only button has no text to fall back on.
    const trigger = screen.getByLabelText("Open menu");
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.className).toContain("size-8");
    expect(trigger.className).toContain("flex-none");
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  test("the trigger opens the menu dialog and reports it as expanded", async () => {
    const user = userEvent.setup();
    renderWithRun(<Header />);

    await user.click(screen.getByLabelText("Open menu"));

    expect(screen.getByRole("dialog", { name: "Menu" })).toBeTruthy();
    expect(screen.getByLabelText("Open menu").getAttribute("aria-expanded")).toBe("true");
  });

  test("the mode badge is an eyebrow on the tracking token, keeping its own 10px size", () => {
    renderWithRun(<Header />);
    const badge = screen.getByText("HITL Mode Active");
    expect(badge.className).toContain("tracking-eyebrow");
    expect(badge.className).not.toContain("tracking-widest");
    // The eyebrow's 11px is the default; this one overrides it rather than growing
    // the header line, and tailwind-merge keeps a single winner.
    expect(badge.className).toContain("text-[10px]");
    expect(badge.className).not.toContain("text-[11px]");
  });

  test("the header carries the theme toggle, named for the action it performs", async () => {
    const user = userEvent.setup();
    renderWithRun(<Header />);

    // Reachable by its name alone: it is the only control in the app that says this.
    const toggle = screen.getByRole("button", { name: "Switch to the light theme" });
    expect(toggle.className).toContain("size-8");

    await user.click(toggle);

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(localStorage.getItem("cf:theme")).toBe("light");
    expect(screen.getByRole("button", { name: "Switch to the dark theme" })).toBeTruthy();
  });
});

describe("Header — the Brief tab (D33)", () => {
  test.each(["/brief", "/brief/new"])("the Brief tab is the current page on %s", (path) => {
    nextMock().nav.pathname = path;
    renderWithRun(<Header />);

    expect(screen.getByRole("link", { name: "Brief" }).getAttribute("aria-current")).toBe("page");
    // The two routes share a prefix, so the tab stays current on both — and no other
    // tab's href is a prefix of another, which is what makes that test safe. Assert
    // every other tab, not just one: a prefix bug would mark a specific tab, and
    // checking a single sibling can only catch it if that is the one it marks.
    for (const other of ["Grid", "Compliance", "Export", "Runs"]) {
      expect(screen.getByRole("link", { name: other }).getAttribute("aria-current")).toBeNull();
    }
  });
});

describe("Header — Generate (D32)", () => {
  beforeEach(() => localStorage.setItem("cf:brief-picked", "1"));

  test("with nothing applied it refuses out loud and routes to the brief, not to the grid", async () => {
    const user = userEvent.setup();
    nextMock().nav.pathname = "/grid";
    renderWithRun(<Header />);

    await user.click(screen.getByRole("button", { name: "Generate" }));

    // Never disabled (D3): the press is the question, and this is the answer — what is
    // missing, and the control that fixes it.
    expect(screen.getByRole("status").textContent).toBe(generateNoBrief);
    expect(nextMock().router.push).toHaveBeenCalledWith("/brief");
    expect(nextMock().router.push).not.toHaveBeenCalledWith("/grid");
    expect(generatePosts()).toHaveLength(0);
  });

  test("on the brief route it says what is missing without navigating anywhere", async () => {
    const user = userEvent.setup();
    nextMock().nav.pathname = "/brief";
    renderWithRun(<Header />);

    await user.click(screen.getByRole("button", { name: "Generate" }));

    // The remedy (Apply, in the editor's action bar) is already on screen here, so the
    // reveal needs no route change.
    expect(screen.getByRole("status").textContent).toBe(generateNoBrief);
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("with an applied brief it runs the brief and takes the user to the grid", async () => {
    const user = userEvent.setup();
    renderWithRun(
      <>
        <ApplyBrief />
        <Header />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "apply" }));

    await user.click(screen.getByRole("button", { name: "Generate" }));

    expect(generatePosts()).toHaveLength(1);
    // Times(1), not just "was called with": a double navigation is a real failure mode
    // and `toHaveBeenCalledWith` alone cannot see it.
    expect(nextMock().router.push).toHaveBeenCalledTimes(1);
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("applying a brief clears the standing refusal", async () => {
    const user = userEvent.setup();
    nextMock().nav.pathname = "/brief";
    renderWithRun(
      <>
        <ApplyBrief />
        <Header />
      </>,
    );

    await user.click(screen.getByRole("button", { name: "Generate" }));
    expect(screen.getByRole("status").textContent).toBe(generateNoBrief);

    // Applying is the answer to the refusal, so the refusal must stop standing —
    // otherwise the header keeps telling the user to do the thing they just did.
    await user.click(screen.getByRole("button", { name: "apply" }));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  test("applying a brief leaves an unrelated notice alone", async () => {
    const user = userEvent.setup();
    renderWithRun(
      <>
        <ApplyBrief />
        <Header />
      </>,
    );

    await user.click(screen.getByTitle("Change image model"));
    const dialog = await screen.findByRole("dialog", { name: "Select image model" });
    await user.click(within(dialog).getByText("Procedural (offline)"));
    expect(screen.getByRole("status").textContent).toBe(modelChanged("Procedural (offline)"));

    // The clear is scoped to the refusal: a model-change notice is about something
    // else and applying a brief does not answer it.
    await user.click(screen.getByRole("button", { name: "apply" }));
    expect(screen.getByRole("status").textContent).toBe(modelChanged("Procedural (offline)"));
  });

  test("a prompt the user accepts navigates AND starts the run", async () => {
    const user = userEvent.setup();
    renderDirty(
      <>
        <ApplyBrief />
        <Header />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "apply" }));

    await user.click(screen.getByRole("button", { name: "Generate" }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(dialog).getByRole("button", { name: "Leave" }));

    // Leaving is consent to the whole gesture, not just to the route change. The guard
    // defers whatever it was handed, so handing it only the push loses the run: the
    // user presses Generate, answers the question, lands on the grid and nothing ran.
    await waitFor(() => expect(generatePosts()).toHaveLength(1));
    expect(nextMock().router.push).toHaveBeenCalledTimes(1);
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
  });

  test("a prompt the user refuses leaves the run unstarted", async () => {
    const user = userEvent.setup();
    renderDirty(
      <>
        <ApplyBrief />
        <Header />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "apply" }));

    await user.click(screen.getByRole("button", { name: "Generate" }));
    // Leaving a dirty draft is the guard's question, and staying is an answer that
    // must cancel the run rather than fire it behind the user's back.
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));

    expect(generatePosts()).toHaveLength(0);
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });
});

describe("Header — Generate's three-way question (D35)", () => {
  beforeEach(() => {
    localStorage.setItem("cf:brief-picked", "1");
    mockPipelineApi();
  });

  /**
   * Stands in for the mounted editor: publishes D35's handoff the way BriefEditor
   * does — the on-screen draft through a ref the editor refreshes, and a save path.
   * The full editor-plus-header flow is driven by the real components in
   * brief-editor.test.tsx; this pins the header's side of the contract.
   */
  const onScreenDraft = {
    id: "on-screen-draft",
    targetRegion: "DE",
    targetAudience: "a",
    campaignMessage: "Hi",
    products: [{ id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" }],
  } as CampaignBrief;

  const PublishDraft = ({ savedBriefId = "saved-copy" }: { savedBriefId?: string }) => {
    const { setDraftRun } = useEditorDirty();
    // The draft rides a stable ref the editor refreshes on every render — the same
    // shape BriefEditor publishes — so "Run this draft" always reads the freshest one.
    const draftRef = useRef<CampaignBrief>(onScreenDraft);
    useEffect(() => {
      setDraftRun({
        draftRef,
        saveAndRun: () => Promise.resolve({ ...onScreenDraft, id: savedBriefId }),
      });
      return () => setDraftRun(null);
    }, [setDraftRun, savedBriefId, draftRef]);
    return null;
  };

  test("with a differing draft the press asks the three-way question — one prompt, never two", async () => {
    const user = userEvent.setup();
    render(
      <ShellProviders>
        <PublishDraft />
        <Header />
      </ShellProviders>,
    );

    await user.click(screen.getByRole("button", { name: "Generate" }));

    // The three-way is the whole gesture's question: the guard's dialog is nowhere
    // behind it — exactly one prompt on any path.
    expect(screen.getByRole("dialog", { name: generateDraftTitle })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
    expect(generatePosts()).toHaveLength(0);
  });

  test('"Run this draft" POSTs the on-screen draft, writes nothing, and navigates once', async () => {
    const user = userEvent.setup();
    render(
      <ShellProviders>
        <PublishDraft />
        <Header />
      </ShellProviders>,
    );

    await user.click(screen.getByRole("button", { name: "Generate" }));
    await user.click(within(screen.getByRole("dialog", { name: generateDraftTitle })).getByRole("button", { name: new RegExp(`^${generateDraftRunThis}`) }));

    await waitFor(() => expect(generatePosts()).toHaveLength(1));
    const body = JSON.parse(String(generatePosts()[0][1]?.body)) as { id?: string };
    expect(body.id).toBe("on-screen-draft");
    // zero writes: no brief POST/PUT left the page — run-without-write
    const briefWrites = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(
        ([url, init]) =>
          String(url).includes("/campaigns/briefs") && (init as RequestInit | undefined)?.method !== "GET",
      );
    expect(briefWrites).toHaveLength(0);
    expect(nextMock().router.push).toHaveBeenCalledTimes(1);
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
  });

  test('"Save and run" writes, then runs what was written', async () => {
    const user = userEvent.setup();
    render(
      <ShellProviders>
        <PublishDraft />
        <Header />
      </ShellProviders>,
    );

    await user.click(screen.getByRole("button", { name: "Generate" }));
    await user.click(within(screen.getByRole("dialog", { name: generateDraftTitle })).getByRole("button", { name: new RegExp(`^${generateDraftSaveRun}`) }));

    await waitFor(() => expect(generatePosts()).toHaveLength(1));
    const body = JSON.parse(String(generatePosts()[0][1]?.body)) as { id?: string };
    // the brief as the server stored it — not the un-written draft
    expect(body.id).toBe("saved-copy");
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
  });

  test("Cancel answers the question and does nothing at all", async () => {
    const user = userEvent.setup();
    render(
      <ShellProviders>
        <PublishDraft />
        <Header />
      </ShellProviders>,
    );

    await user.click(screen.getByRole("button", { name: "Generate" }));
    await user.click(within(screen.getByRole("dialog", { name: generateDraftTitle })).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog", { name: generateDraftTitle })).toBeNull();
    expect(generatePosts()).toHaveLength(0);
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("the backdrop answers the question too — nothing runs", async () => {
    const user = userEvent.setup();
    render(
      <ShellProviders>
        <PublishDraft />
        <Header />
      </ShellProviders>,
    );

    await user.click(screen.getByRole("button", { name: "Generate" }));
    expect(screen.getByRole("dialog", { name: generateDraftTitle })).toBeTruthy();

    // click the overlay itself, not the card inside it
    const overlay = screen.getByRole("dialog", { name: generateDraftTitle });
    fireEvent.click(overlay);

    expect(screen.queryByRole("dialog", { name: generateDraftTitle })).toBeNull();
    expect(generatePosts()).toHaveLength(0);
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("Escape answers the question as a cancel — nothing runs (DESIGN §7)", async () => {
    const user = userEvent.setup();
    render(
      <ShellProviders>
        <PublishDraft />
        <Header />
      </ShellProviders>,
    );

    await user.click(screen.getByRole("button", { name: "Generate" }));
    expect(screen.getByRole("dialog", { name: generateDraftTitle })).toBeTruthy();

    // a key that is not Escape answers nothing
    fireEvent.keyDown(window, { key: "Shift" });
    expect(screen.getByRole("dialog", { name: generateDraftTitle })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: generateDraftTitle })).toBeNull();
    expect(generatePosts()).toHaveLength(0);
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("a refused save answers the question with nothing to run", async () => {
    const user = userEvent.setup();
    // The editor's save path resolves null when it refused the draft (invalid, or the
    // write failed) — the refusal is spoken by the editor, so the header adds nothing
    // and runs nothing.
    const RefusingDraft = () => {
      const { setDraftRun } = useEditorDirty();
      const draftRef = useRef<CampaignBrief>(onScreenDraft);
      useEffect(() => {
        setDraftRun({ draftRef, saveAndRun: () => Promise.resolve(null) });
        return () => setDraftRun(null);
      }, [setDraftRun, draftRef]);
      return null;
    };
    render(
      <ShellProviders>
        <RefusingDraft />
        <Header />
      </ShellProviders>,
    );

    await user.click(screen.getByRole("button", { name: "Generate" }));
    await user.click(
      within(screen.getByRole("dialog", { name: generateDraftTitle })).getByRole("button", {
        name: new RegExp(`^${generateDraftSaveRun}`),
      }),
    );

    await waitFor(() => expect(screen.queryByRole("dialog", { name: generateDraftTitle })).toBeNull());
    expect(generatePosts()).toHaveLength(0);
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("without a differing draft the press behaves as it always has (the C4 path)", async () => {
    const user = userEvent.setup();
    mockPipelineApi({ job: () => jobOk({ halted: false, assets: [], log: { entries: [] } }) });
    renderWithRun(
      <>
        <ApplyBrief />
        <Header />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "apply" }));

    await user.click(screen.getByRole("button", { name: "Generate" }));

    // No three-way, no guard dialog: the committed brief runs at once.
    expect(screen.queryByRole("dialog", { name: generateDraftTitle })).toBeNull();
    await waitFor(() => expect(generatePosts()).toHaveLength(1));
    const body = JSON.parse(String(generatePosts()[0][1]?.body)) as { id?: string };
    expect(body.id).toBe("applied-brief");
  });
});

describe("Header — the brand mark and the telemetry control", () => {
  beforeEach(() => localStorage.setItem("cf:brief-picked", "1"));

  test("the brand mark goes home through the guard, prompting exactly once", async () => {
    const user = userEvent.setup();
    nextMock().router.push.mockClear();
    renderDirty(<Header />);

    await user.click(screen.getByRole("link", { name: /Campaign Pipeline/ }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });

    await user.click(within(dialog).getByRole("button", { name: "Leave" }));
    expect(nextMock().router.push).toHaveBeenCalledTimes(1);
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
  });

  // The same guard lane W1 added to MobileMenu, which was never mirrored here: a
  // modified or non-primary click is the browser's own job (new tab / new window /
  // download) and must not be intercepted into a dirty prompt.
  test.each(["metaKey", "ctrlKey", "shiftKey", "altKey", "button"] as const)(
    "a %s click on the brand mark is left to the browser, even with unsaved edits",
    (modifier) => {
      nextMock().router.push.mockClear();
      renderDirty(<Header />);
      fireEvent.click(screen.getByRole("link", { name: /Campaign Pipeline/ }), {
        [modifier]: modifier === "button" ? 1 : true,
      });
      expect(nextMock().router.push).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
    },
  );

  test("a brand-mark prompt the user refuses does not navigate", async () => {
    const user = userEvent.setup();
    nextMock().router.push.mockClear();
    renderDirty(<Header />);

    await user.click(screen.getByRole("link", { name: /Campaign Pipeline/ }));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));

    // Staying is an answer, and it must hold the user where they are — the guard's
    // whole contract is that a refused action never fires.
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("the telemetry button opens the drawer and asks the dirty guard nothing", async () => {
    const user = userEvent.setup();
    renderDirty(<Header />);

    // A panel, not a dialog, and it changes no draft: a press must never prompt, even
    // with unsaved edits standing.
    const button = screen.getByLabelText(telemetryButton);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    await user.click(button);

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("changing the image model says which model the next run will use", async () => {
    const user = userEvent.setup();
    renderWithRun(<Header />);

    await user.click(screen.getByTitle("Change image model"));
    const dialog = await screen.findByRole("dialog", { name: "Select image model" });
    await user.click(within(dialog).getByText("Procedural (offline)"));

    expect(screen.getByRole("status").textContent).toBe(modelChanged("Procedural (offline)"));
  });
});
