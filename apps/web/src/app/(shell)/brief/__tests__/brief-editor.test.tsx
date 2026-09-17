import { describe, test, expect, beforeAll, beforeEach, vi } from "vitest";
import { Profiler } from "react";
import * as messages from "@/components/campaign/messages";
import { screen, waitFor, within, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  renderWithRun as renderWithShell,
  json,
  nextMock,
  ShellProviders,
} from "@/__tests__/helpers";
import { API, useRun } from "@/lib/run-context";
import { useEditorDirty } from "@/lib/editor-dirty-context";
import { CreateCampaignProvider } from "@/lib/create-campaign-context";
import { CREATE_SEED_KEY, createCampaign, takeSeed } from "@/lib/create-campaign";
import { CreateCampaignDialog } from "@/components/shell/CreateCampaignDialog";
import { BrowseBriefsButton } from "@/components/shell/Sidebar";
import type { BriefEntry } from "@/lib/briefs-api";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";
import { clickDestinationProblem } from "@campaignfoundry/CampaignOrchestration/click-destination";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import {
  fromBrief,
  initialEditorState,
  saveDraftToStorage,
} from "@/components/campaign/editor-state";
import { sectionOrder, SECTION_TITLES } from "@/components/campaign/sections";
import { BriefEditor } from "@/components/campaign/BriefEditor";
import { PREVIEW_RAIL_MIN_INLINE_PX } from "@/lib/use-min-inline-size";
import NewBriefPage from "../new/page";
import { Header } from "@/components/shell/Header";

/**
 * This suite pins the editor's data flow. The map's behaviour is pinned by
 * identity-section.test.tsx and world-map.test.tsx. The real WorldMap paints
 * hundreds of SVG nodes per mount under happy-dom; a stub keeps this file
 * honest about the editor without that cost.
 */
vi.mock("@/components/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui")>();
  return {
    ...actual,
    WorldMap: ({ value }: { value: string | null }) => (
      <div data-testid="world-map-stub" data-value={value ?? ""} />
    ),
  };
});

/**
 * W1: the create dialog and its provider are shell-layer mounts beside the editor —
 * the same tree the shell layout builds — so the create gesture is exercisable end
 * to end from this suite.
 */
const renderWithRun = (ui: React.ReactElement) =>
  renderWithShell(
    <CreateCampaignProvider>
      {ui}
      <CreateCampaignDialog />
    </CreateCampaignProvider>,
  );

/**
 * The editor as a user meets it, at the route the URL names. D37: which brief is
 * open is the URL's word — a test adopts a brief by rendering at its route, the
 * way Next does when the user arrives (or reloads) there.
 */
const Editor = ({ id }: { id?: string }) => <BriefEditor briefId={id} />;

/** `/brief/new` — the same editor, started empty. */
const NewEditor = () => <NewBriefPage />;

/** Corrected for D35's verb model: Save is the bar's primary, one press; Save as…
 *  lives in the overflow — the old disclosure that hid Save behind Save is gone. */
const saveVia = async (user: ReturnType<typeof userEvent.setup>, item: "Save" | "Save as") => {
  if (item === "Save") {
    await user.click(screen.getByRole("button", { name: /^Save$/ }));
    return;
  }
  await user.click(screen.getByText("⋯"));
  await user.click(await screen.findByText(messages.editorSaveAs));
};

/** Shows the brief the shell would run, so a test can assert Save retargeted the run. */
const RunBriefProbe = () => {
  const { brief } = useRun();
  return <span data-testid="run-brief">{brief.id}</span>;
};

/**
 * The EDITOR column's own status line (D38), which is one — not the rail's.
 *
 * TS1 gave the timeline tape its own `role="status"` sentence (rail-timeline plan
 * §3.5), so a bare `getByRole("status")` on a motion draft now finds two live
 * regions in two different landmarks. Filtering by landmark keeps what these
 * assertions have always meant — the refusal the action bar owes, in the column,
 * exactly once — rather than weakening them to "some status somewhere says it".
 */
const editorStatuses = () =>
  screen.getAllByRole("status").filter((el) => el.closest('[role="complementary"]') === null);

const brief = (id: string) => ({
  schemaVersion: 1,
  template: templateFromCanonical(DEFAULT_CAMPAIGN_TYPE),
  id,
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [
    { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" },
    { id: "beta", name: "B", primaryColor: "#E0218A", logoPath: "b.png" },
  ],
});

const entry = (id: string, revision?: string) => ({
  file: `${id}.yaml`,
  brief: brief(id),
  revision,
});

/** Route each call by URL+method; unmatched calls fail loudly rather than hanging.
 *  The write handlers receive the parsed request body, so a test can echo it back —
 *  what the real routes do (`parseBrief(await readBody(...))`), key order included. */
const routes = (handlers: {
  list?: () => Response | Promise<Response>;
  post?: (url: string, body?: Record<string, unknown>) => Response | Promise<Response>;
  put?: (url: string, body?: Record<string, unknown>) => Response | Promise<Response>;
  capabilities?: () => Response | Promise<Response>;
}) => {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = init?.body;
    const parsed =
      typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    calls.push({
      url: u,
      method,
      ...(parsed ? { body: parsed } : {}),
    });
    if (method === "GET" && u === `${API}/campaigns/capabilities`) {
      return Promise.resolve(handlers.capabilities?.() ?? json({ motion: true }));
    }
    if (method === "GET" && u.startsWith(`${API}/campaigns/briefs`)) {
      return Promise.resolve(handlers.list?.() ?? json({ briefs: [] }));
    }
    // The defaults match what the real routes answer — `{ file, brief, revision }`:
    // a write mock less truthful than the route sends the next lane home green on
    // an editor that drops the revision. The POST echoes the brief it was sent,
    // the way the real route stores what it parsed — so the stored brief's id (and
    // therefore the route the editor navigates to after a copy) is the caller's.
    if (method === "POST") {
      const stored = parsed ?? brief("x");
      return Promise.resolve(
        handlers.post?.(u, parsed) ??
          json({ file: `${stored.id}.yaml`, brief: stored, revision: "mock-rev" }, 201),
      );
    }
    if (method === "PUT")
      return Promise.resolve(
        handlers.put?.(u, parsed) ??
          json({ file: "x.yaml", brief: brief("x"), revision: "mock-rev" }),
      );
    return Promise.resolve(json({}, 404));
  });
  return calls;
};

/**
 * The calls that actually WROTE something.
 *
 * `EstimatePanel` fires `planCampaign` — a POST to /campaigns/plan — on a
 * PLAN_DEBOUNCE_MS (250 ms) timer whenever the draft changes. It is a dry run: it
 * persists nothing. A refusal test that asserts "no non-GET call happened" therefore
 * races that timer, and a test doing a dozen awaited clicks loses the race on a loaded
 * runner while passing locally. That is a real flake, seen once on #99's CI and green on
 * rerun.
 *
 * The preview rail's own POST to /campaigns/preview-frame (CC1/D141) is the same class
 * of call for the same reason: it renders a preview frame and persists nothing. Once the
 * rail widened to every presentation and (almost) every step, it now paints — and fetches
 * — in scenarios these refusal tests exercise (a Randomized draft whose first product has
 * an id), so excluding it here is not a special case for one test; every test in this file
 * that means "nothing was written" needs the same correction.
 *
 * So these tests assert what they mean — nothing was written — rather than the stricter
 * statement that no request of any kind was issued. Any other non-GET, including a stray
 * /campaigns/generate, still fails.
 */
const writes = (calls: readonly { url: string; method: string }[]) =>
  calls.filter(
    (c) =>
      c.method !== "GET" &&
      !c.url.includes("/campaigns/plan") &&
      !c.url.includes("/campaigns/preview-frame"),
  );

const waitForEditorReady = async () =>
  waitFor(() =>
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).not.toBe(""),
  );

/**
 * X34: this helper exists to get the draft into a valid state so a test's real
 * assertion can run — none of these eight values is itself under test anywhere
 * in this file (every test that cares what a keystroke does — validation,
 * touched, dirty, coalescing — drives `userEvent` directly in its own body, not
 * through here). So setup pays the cheapest form that reaches the same state,
 * while keeping the same *interaction shape* `userEvent.type` produces, not
 * only the same final value: `fireEvent.click` marks the field's section
 * touched exactly as the click `userEvent.type` fires before every keystroke
 * does (`touchSectionFromEvent`'s `onClickCapture`); `el.focus()` moves real
 * DOM focus, which blurs whatever was focused before (marking that field
 * touched, `handleMainBlur`'s `onBlurCapture`) the same way focus moving to
 * the next field does mid-typing; `fireEvent.change` sets the final value in
 * one dispatch instead of one per character. The last field's `.focus()` is
 * never followed by another, so it stays focused exactly as `userEvent.type`
 * leaves it — nothing here blurs it. Proven equal, not assumed: see
 * "fillValidDraft's fast path produces the same draft, touched sections, and
 * focus the typed path produces" below, which compares the saved brief, which
 * sections show their validation, and `document.activeElement` between the
 * two paths, and is relied on unchanged by the X32 keystroke-commit test
 * (which revisits Target Region as an already-touched field afterwards).
 */
const setField = (el: HTMLElement, value: string) => {
  fireEvent.click(el);
  el.focus();
  fireEvent.change(el, { target: { value } });
};

const fillValidDraft = async (user: ReturnType<typeof userEvent.setup>, id = "fresh") => {
  setField(screen.getByLabelText("Campaign Name"), id);
  setField(screen.getByLabelText("Target Region"), "DE");
  setField(screen.getByLabelText("Target Audience"), "a");
  setField(screen.getByLabelText("Headline"), "Hi");
  let names = screen.getAllByLabelText("Name");
  if (names.length < 2) {
    await user.click(screen.getByRole("button", { name: "Add product" }));
    names = screen.getAllByLabelText("Name");
  }
  setField(names[0], "A");
  setField(names[1], "B");
  const logos = screen
    .getAllByLabelText("Logo Path")
    .filter((el) => el.tagName === "INPUT" && el.getAttribute("type") !== "file");
  setField(logos[0], "a.png");
  setField(logos[1], "b.png");
};

describe("BriefPage — data flow", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  test("loads the brief list on mount and again when the window regains focus", async () => {
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor />);

    await waitFor(() => expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(0));
    const onMount = calls.filter((c) => c.method === "GET").length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(onMount),
    );
  });

  test("a failing list is logged rather than thrown", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    routes({ list: () => json({ error: "boom" }, 500) });
    renderWithRun(<Editor />);
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Failed to load briefs:", expect.anything()),
    );
    error.mockRestore();
  });

  test("selecting a brief navigates to its route, and the route loads it with the revision it was listed with", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "rev-abc")] }) });
    const view = renderWithRun(<Editor />);
    await waitFor(() => expect(screen.getByText("New brief...")).toBeTruthy());

    // D37: the picker and the editor's own selector both choose by navigating.
    await user.click(screen.getByText("New brief..."));
    await user.click(await screen.findByText("camp"));
    expect(nextMock().router.push).toHaveBeenCalledWith("/brief/camp");

    // Next answers the push with the route's editor; the route drives the load.
    // W1: the rerender keeps the wrapper's tree shape (provider + dialog), so the
    // editor instance survives and the route prop change is what drives the load.
    view.rerender(
      <ShellProviders>
        <CreateCampaignProvider>
          <Editor id="camp" />
          <CreateCampaignDialog />
        </CreateCampaignProvider>
      </ShellProviders>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await saveVia(user, "Save");
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT");
      expect(put?.url).toContain("revision=rev-abc");
    });
  });

  test("a new draft is saved with a POST carrying what was typed", async () => {
    const user = userEvent.setup();
    const calls = routes({});
    // A blank draft is a route now, so ask for it directly instead of clicking the
    // editor back to empty.
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );

    await fillValidDraft(user);

    await waitFor(() =>
      expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await saveVia(user, "Save");

    const post = await waitFor(() => {
      const call = calls.find((c) => c.method === "POST");
      expect(call).toBeTruthy();
      return call!;
    });
    expect(post.url).not.toContain("replace=1");
    expect(post.body).toMatchObject({
      id: "fresh",
      targetRegion: "DE",
      targetAudience: "a",
      campaignMessage: "Hi",
      products: [
        expect.objectContaining({ id: "a", name: "A", logoPath: "a.png" }),
        expect.objectContaining({ id: "b", name: "B", logoPath: "b.png" }),
      ],
    });
  });

  test("a failed save surfaces the message", async () => {
    const user = userEvent.setup();
    routes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      put: () => json({ error: "conflict" }, 409),
    });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await saveVia(user, "Save");
    expect(await screen.findByText(/conflict/)).toBeTruthy();
  });

  test("Save is one press — it writes and retargets the run, with no menu in between", async () => {
    const user = userEvent.setup();
    const calls = routes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      put: () => json({ file: "camp.yaml", brief: brief("camp"), revision: "r2" }),
    });
    renderWithRun(
      <>
        <RunBriefProbe />
        <Editor id="camp" />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    // The verb model (D35): Save is the verb itself, not a disclosure whose first
    // item is also called Save — the bar must carry no menu before the press.
    expect(screen.queryByRole("menu")).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Save$/ }));

    const write = await waitFor(() => {
      const call = writes(calls)[0];
      expect(call).toBeTruthy();
      return call!;
    });
    expect(write.method).toBe("PUT");
    // and the shell runs what was written — one press did both
    await waitFor(() => expect(screen.getByTestId("run-brief").textContent).toBe("camp"));
    // still no menu afterwards: one press, one write, nothing else opened
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("Save as… is reachable in one press from the overflow", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await user.click(screen.getByText("⋯"));
    await user.click(screen.getByText(messages.editorSaveAs));

    // the dialog is the Save-as surface, exactly as it was behind the old disclosure
    expect(screen.getByRole("dialog", { name: /Save as/ })).toBeTruthy();
  });

  test("Save is held back only while a write is in flight, and says so", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<Response>((resolve) => {
      release = () => resolve(json({ file: "x.yaml", brief: brief("camp"), revision: "mock-rev" }));
    });
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }), put: () => gate });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    const save = screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await user.click(save);

    // In flight: the button is disabled and wears `aria-busy` (the isLoading render
    // replaces its label with the spinner, so find it by the busy state). This is the
    // only thing that closes the verb off — an invalid draft never does (D3).
    await waitFor(() => {
      const busy = screen
        .getAllByRole("button")
        .find((b) => b.getAttribute("aria-busy") === "true");
      expect(busy).toBeTruthy();
      expect((busy as HTMLButtonElement).disabled).toBe(true);
    });

    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Save$/ })).toBeTruthy());
    expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  test("Save as... creates a copy under the new id and closes the dialog", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    await waitFor(() => expect(screen.queryByLabelText("New brief id")).toBeNull());
  });

  test("a failed Save as... keeps the dialog open and shows why", async () => {
    const user = userEvent.setup();
    routes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      post: () => json({ error: "already exists" }, 409),
    });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );

    // The collision (a 409 the listing did not foresee) asks first (D9); the
    // overwrite itself is the retry.
    const prompt = await screen.findByRole("dialog", { name: messages.saveAsOverwriteTitle });
    await user.click(within(prompt).getByRole("button", { name: messages.saveAsOverwriteConfirm }));

    // The retry failed too: the error is on screen and the Save-as dialog is still
    // open, exactly the answer any save failure gives.
    expect(await screen.findByText(/already exists/)).toBeTruthy();
    expect(screen.getByLabelText("New brief id")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: messages.saveAsOverwriteTitle })).toBeNull();
  });

  test("the Save as... field is the kit input, so it has the focus halo it lacked", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    const field = screen.getByLabelText("New brief id");
    expect(field.className).toContain("focus:ring-brand-primary/25");
    expect(field.className).toContain("focus:border-brand-primary");
  });

  test("the Save as... dialog can be dismissed", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    // Corrected for D35: the action bar now carries its own Cancel verb, so the
    // dialog's Cancel is addressed inside the dialog it belongs to.
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(screen.queryByLabelText("New brief id")).toBeNull();
  });

  test("New brief... opens the create dialog rather than navigating (W1)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    // reopen the selector and choose the create-new row
    await user.click(screen.getAllByText("camp")[0]);
    await user.click(screen.getByText("New brief..."));
    // W1 (D66): the create gesture is a door to the dialog now — the blank route is
    // reached by the dialog's Create, so nothing navigates here.
    expect(nextMock().router.push).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
  });

  test("the blank route stays blank, however loud the shell is about its active brief", async () => {
    localStorage.setItem("cf:brief", JSON.stringify(brief("camp")));
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<NewEditor />);

    // wait for the listing, which is what used to trigger the adoption: a blank draft is
    // pristine, so the dirty guard let it through and `camp` landed in the form. The
    // route is what refuses it now.
    await waitFor(() => expect(calls.some((c) => c.url.includes("/campaigns/briefs"))).toBe(true));
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Target Region") as HTMLInputElement).value).toBe("");
    expect(document.querySelector('[data-testid="world-map-stub"]')).toBeTruthy();
    expect(document.querySelector("[data-region]")).toBeNull();
  });

  test("New brief... on a dirty blank route asks once, then opens the dialog (W1)", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );
    await fillValidDraft(user, "typed");
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("typed");

    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(screen.getAllByText("New brief...").slice(-1)[0]);

    // W1 (D67): the guard's one question comes before the dialog opens. The in-place
    // emptying this row used to do is the create seed's job now.
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(screen.getAllByRole("dialog", { name: "Unsaved edits" })).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull();
    await user.click(within(prompt).getByRole("button", { name: "Leave" }));

    // Consent opens the dialog; opening it discarded nothing by itself.
    expect(await screen.findByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    // The editor's own field (the open dialog carries a second, empty one).
    const editorName = screen
      .getAllByLabelText(messages.campaignNameLabel)
      .find((el) => el.closest('[role="dialog"]') === null) as HTMLInputElement;
    expect(editorName.value).toBe("typed");
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test("a clean editor's New brief opens the dialog without asking (W1)", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );

    // W1 (D66): a pristine draft has nothing to lose, so the guard never prompts —
    // the row's old in-place reset is the create seed's job now.
    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(screen.getAllByText("New brief...").slice(-1)[0]);
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
    expect(await screen.findByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
  });

  test("declining the prompt keeps what was typed and opens no dialog (W1)", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );
    await fillValidDraft(user, "typed");

    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(screen.getAllByText("New brief...").slice(-1)[0]);

    // The refusal (Stay) is inert: no navigation, the draft keeps the edits the user
    // declined to throw away, and (D67) the create dialog never opened.
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(prompt).getByRole("button", { name: messages.confirmDialogStay }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull());
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("typed");
    expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull();
  });

  test("Save as... on the blank route also stops the URL calling it new", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );
    await fillValidDraft(user, "fresh");

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "elsewhere");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );

    // D37: the copy's identity lives in the URL — the route must stop calling it new.
    await waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/brief/elsewhere"));
  });

  test("Save as... keeps the copy's revision, so the next save still guards the write", async () => {
    const user = userEvent.setup();
    // D37: the route drives the load, so the listing the route reads must gain the
    // copy — and the test simulates Next answering the replace with the new route.
    let listed: BriefEntry[] = [entry("camp", "r1")];
    const calls = routes({
      list: () => json({ briefs: listed }),
      post: (_url, body) => {
        const stored = { file: "copy.yaml", brief: body as never, revision: "rev-copy" };
        listed = [...listed, stored];
        return json(stored, 201);
      },
    });
    const view = renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );
    await waitFor(() => expect(screen.queryByLabelText("New brief id")).toBeNull());
    // W1: the rerender keeps the wrapper's tree shape (provider + dialog), so the
    // editor instance survives and the route prop change is what drives the load.
    view.rerender(
      <ShellProviders>
        <CreateCampaignProvider>
          <Editor id="copy" />
          <CreateCampaignDialog />
        </CreateCampaignProvider>
      </ShellProviders>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("copy"),
    );

    // saving the copy must send the revision the POST handed back; without it the write
    // silently drops to last-write-wins, the trap `loadBrief` carries the revision to avoid
    await saveVia(user, "Save");
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.url.includes("revision=rev-copy"))).toBe(
        true,
      ),
    );
  });

  test("Save as... onto the id this route already names adopts the stored copy in place", async () => {
    const user = userEvent.setup();
    const calls = routes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      // a stored answer without a revision is the `entry`-less shape the load path
      // must tolerate (the same case "a write response without a revision" covers
      // for handleSave)
      post: (_url, body) => json({ file: "camp.yaml", brief: body as never }, 201),
    });
    renderWithRun(
      <>
        <RunBriefProbe />
        <Editor id="camp" />
      </>,
    );
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "camp");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );

    // the id is taken (the listing knows it): the overwrite dialog asks, and the
    // user's accept is what retries with ?replace=1 (D9)
    const prompt = await screen.findByRole("dialog", { name: messages.saveAsOverwriteTitle });
    await user.click(within(prompt).getByRole("button", { name: messages.saveAsOverwriteConfirm }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === "POST" && c.url.includes("replace=1"))).toBe(true),
    );

    // ...and the stored copy was adopted in place: both dialogs close, the shell
    // follows it, and the URL never needed to move. Same-id overwrite does not
    // unmount the editor, so the overwrite dialog has to clear on the success path.
    await waitFor(() => expect(screen.queryByLabelText("New brief id")).toBeNull());
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: messages.saveAsOverwriteTitle })).toBeNull(),
    );
    await waitFor(() => expect(screen.getByTestId("run-brief").textContent).toBe("camp"));
    expect(nextMock().router.replace).not.toHaveBeenCalled();
  });

  test("Save as... with a non-slug id never reaches createBrief, and the field says why", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    // a campaign *name* where a slug is wanted — the exact input that once left the
    // page as a 288-byte POST and came back a bare 400
    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "Trail Blaze 2026");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );

    expect(writes(calls)).toEqual([]);
    expect(screen.getByText(messages.briefId)).toBeTruthy();
    expect(screen.getByLabelText("New brief id")).toBeTruthy();
  });

  test("neither Escape nor Cancel dismisses Save as… while the write is in flight", async () => {
    const user = userEvent.setup();
    // A POST that never answers, so the dialog stays mid-write for the whole test.
    routes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      post: () => new Promise<Response>(() => {}),
    });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "trail-blaze-2026");
    const dialog = screen.getByRole("dialog", { name: /Save as/ });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    // `handleSaveAs` captured the draft before awaiting and dispatches `load` — a
    // full state replace — when the server answers. Dismissing here would hand the
    // user an editable page whose edits that pending load is about to discard.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: /Save as/ })).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("Save as... offers the slugified form of a name as a click, never a silent rewrite", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "Trail Blaze 2026");
    await user.click(await screen.findByRole("button", { name: 'Try "trail-blaze-2026" instead' }));

    // the offer fills the field with the slug the user can see and accept
    expect((screen.getByLabelText("New brief id") as HTMLInputElement).value).toBe(
      "trail-blaze-2026",
    );
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
  });

  test("Save as... refuses an id that slugifies to nothing, with no suggestion to offer", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "!!!");
    expect(screen.getByText(messages.briefId)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /instead/ })).toBeNull();
  });

  test("pressing Save with an invalid id answers by handing focus back to the field", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "!!!");
    // the press comes from somewhere else on the page, not the already-focused field
    const saveButton = within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", {
      name: "Save",
    });
    saveButton.focus();
    await user.click(saveButton);

    // D3: a live button answers — the guard hands focus back to the field the rule
    // is about, so the press produces a visible response instead of silence
    expect(document.activeElement).toBe(screen.getByLabelText("New brief id"));
  });

  test("Save as... trims the id before posting", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), " my-brief ");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );

    const post = await waitFor(() => {
      const call = calls.find((c) => c.method === "POST");
      expect(call).toBeTruthy();
      return call!;
    });
    expect((post.body as { id?: string }).id).toBe("my-brief");
  });

  test("two consecutive saves of a loaded brief both succeed — the second carries the revision the first was handed back", async () => {
    const user = userEvent.setup();
    const calls = routes({
      list: () => json({ briefs: [entry("camp", "rev-load")] }),
      put: () => json({ file: "camp.yaml", brief: brief("camp"), revision: "rev-2" }, 200),
    });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    // the first save guards with the load-time revision...
    await saveVia(user, "Save");
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").length).toBe(1));
    // ...and the second must guard with the revision the first PUT returned. Discarding
    // it replayed rev-load, the write 409'd with an untrue "Brief was modified by
    // another user.", and the only way out was reloading the brief.
    await saveVia(user, "Save");
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").length).toBe(2));

    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts[0].url).toContain("revision=rev-load");
    expect(puts[1].url).toContain("revision=rev-2");
  });

  test("an edit typed while the save is in flight survives it, stays dirty, and the next save carries the fresh revision", async () => {
    const user = userEvent.setup();
    let resolvePut: (response: Response) => void = () => {};
    const calls = routes({
      list: () => json({ briefs: [entry("camp", "rev-load")] }),
      // hold the save in flight until the test releases it, like a real round trip
      put: () =>
        new Promise<Response>((resolve) => {
          resolvePut = resolve;
        }),
    });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await saveVia(user, "Save");
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));

    // the user types while the request is still pending
    await user.type(screen.getByLabelText("Target Audience"), " who hike");
    resolvePut(json({ file: "camp.yaml", brief: brief("camp"), revision: "rev-2" }));

    // (a) the in-flight edit survives — `save` never replaces the draft the way `load` did
    // Corrected for D41: the chip is two-state now, so an unsaved edit reads
    // "Unsaved changes" (written-or-not) rather than "Applied, unsaved edits".
    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeTruthy());
    expect((screen.getByLabelText("Target Audience") as HTMLInputElement).value).toBe("a who hike");
    // (b) is the chip above: the edit reads dirty against what the server stored.

    // (c) the next save answers the guard with the revision the first save was
    // handed back, rather than replaying the load-time one and 409ing
    await saveVia(user, "Save");
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").length).toBe(2));
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts[1].url).toContain("revision=rev-2");
  });

  test("a 409 adopts the fresh revision it carried and offers the retry as the user's choice", async () => {
    const user = userEvent.setup();
    let putCount = 0;
    const calls = routes({
      list: () => json({ briefs: [entry("camp", "rev-load")] }),
      put: () => {
        putCount += 1;
        return putCount === 1
          ? json({ error: "Brief was modified by another user.", revision: "rev-fresh" }, 409)
          : json({ file: "camp.yaml", brief: brief("camp"), revision: "rev-3" });
      },
    });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await saveVia(user, "Save");
    // the refusal says what happened and what to do — the overwrite is never re-sent
    // automatically, because the guard exists to make the other write visible
    expect(await screen.findByText(messages.statusSaveConflict)).toBeTruthy();

    // the fresh revision was adopted, so the next Save answers the guard instead of
    // the user reloading the brief
    await saveVia(user, "Save");
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT").length).toBe(2));
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts[1].url).toContain("revision=rev-fresh");
  });

  test("a non-conflict save failure is reported without adopting anything", async () => {
    const user = userEvent.setup();
    routes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      put: () => json({ error: "disk full" }, 500),
    });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await saveVia(user, "Save");
    expect(await screen.findByText(/disk full/)).toBeTruthy();
  });

  test("a write response without a revision still lands the snapshot clean", async () => {
    const user = userEvent.setup();
    routes({
      list: () => json({ briefs: [entry("camp", "rev-load")] }),
      put: (_url, body) => json({ file: "camp.yaml", brief: body }),
    });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await saveVia(user, "Save");
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });

  test("a 409 on a first-time save has no baseline to adopt the fresh revision against", async () => {
    const user = userEvent.setup();
    routes({
      post: () => json({ error: 'Brief "fresh" already exists.', revision: "rev-fresh" }, 409),
    });
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );
    await fillValidDraft(user, "fresh");

    await saveVia(user, "Save");
    // the server's own refusal stands: a first save has no file identity, so the
    // revision in the body cannot be adopted and no retry is offered
    expect(await screen.findByText(/already exists/)).toBeTruthy();
    expect(screen.queryByText(messages.statusSaveConflict)).toBeNull();
  });

  test("a 409 on a file source with no saved snapshot is refused generically, not adopted", async () => {
    const user = userEvent.setup();
    // a file identity without a baseline — the shape a legacy or hand-edited draft
    // can carry. Nothing to keep dirty against, so nothing to protect on a conflict.
    const orphan = fromBrief(brief("camp") as never, { file: "camp.yaml", revision: "r1" });
    saveDraftToStorage({
      ...orphan,
      source: {
        kind: "file",
        file: "camp.yaml",
        loadedId: "camp",
        savedSnapshot: null,
        revision: "r1",
      },
    });
    routes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      put: () => json({ error: "Brief was modified by another user.", revision: "rev-fresh" }, 409),
    });
    renderWithRun(<Editor id="camp" />);
    // the route loads camp, then draft recovery restores the orphan over it
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await saveVia(user, "Save");
    expect(await screen.findByText(/Brief was modified by another user/)).toBeTruthy();
  });

  test("Save as... adopts the brief the server stored, asset-path rewrites included", async () => {
    const user = userEvent.setup();
    const stored = brief("copy");
    stored.products[0].logoPath = "assets/inputs/copy/a.png";
    // D37: the route drives the load, so the listing the route reads must gain the
    // copy the server stored — rewritten asset paths included.
    let listed: BriefEntry[] = [entry("camp", "r1")];
    routes({
      list: () => json({ briefs: listed }),
      post: () => {
        listed = [...listed, { file: "copy.yaml", brief: stored, revision: "rev-copy" }];
        return json({ file: "copy.yaml", brief: stored, revision: "rev-copy" }, 201);
      },
    });
    const view = renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );
    await waitFor(() => expect(screen.queryByLabelText("New brief id")).toBeNull());
    // W1: the rerender keeps the wrapper's tree shape (provider + dialog), so the
    // editor instance survives and the route prop change is what drives the load.
    view.rerender(
      <ShellProviders>
        <CreateCampaignProvider>
          <Editor id="copy" />
          <CreateCampaignDialog />
        </CreateCampaignProvider>
      </ShellProviders>,
    );

    // the editor shows the path the server rewrote during the copy — dispatching the
    // brief this page constructed instead silently reverted it while the file on disk
    // carried the rewritten one
    const logos = screen
      .getAllByLabelText("Logo Path")
      .filter((el) => el.tagName === "INPUT" && el.getAttribute("type") !== "file");
    expect((logos[0] as HTMLInputElement).value).toBe("assets/inputs/copy/a.png");
  });

  /**
   * Corrected for D35: "Apply to run" is retired. The capability it carried — running
   * a brief that was never written to disk — moves to Generate's three-way question,
   * so this is now the proof that a NEW, NEVER-SAVED brief stays runnable (retiring
   * Apply without it would have made a brand-new brief unrunnable — a regression,
   * not a simplification), and that running it writes nothing.
   */
  test("a new, never-saved brief is runnable: Generate's 'Run this draft' POSTs the on-screen draft with zero writes", async () => {
    const user = userEvent.setup();
    const calls = routes({});
    renderWithRun(
      <>
        <Header />
        <NewEditor />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );
    await fillValidDraft(user, "fresh");

    // The editor publishes the differing draft; Generate asks instead of running the
    // previous campaign silently.
    await user.click(screen.getByRole("button", { name: "Generate" }));
    const dialog = await screen.findByRole("dialog", { name: messages.generateDraftTitle });
    // Exactly one prompt: the guard's "Unsaved edits" is nowhere behind the question.
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();

    await user.click(
      within(dialog).getByRole("button", { name: new RegExp(`^${messages.generateDraftRunThis}`) }),
    );

    // The on-screen draft was POSTed — not the shell's (empty) brief...
    const generatePost = await waitFor(() => {
      const call = calls.find((c) => c.url.includes("/campaigns/generate"));
      expect(call).toBeTruthy();
      return call!;
    });
    expect((generatePost.body as { id?: string }).id).toBe("fresh");
    // ...and zero brief writes left the page: run-without-write.
    expect(calls.filter((c) => c.method !== "GET" && c.url.includes("/campaigns/briefs"))).toEqual(
      [],
    );
  });

  test("arriving on the blank route lets go of the campaign being left", async () => {
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    // the shell is on `camp`, with unsaved edits to it in storage
    localStorage.setItem("cf:brief", JSON.stringify(brief("camp")));
    saveDraftToStorage(fromBrief(brief("camp"), { file: "camp.yaml" }));

    renderWithRun(<NewEditor />);

    // D37/H5: the last-opened record survives — visiting /brief/new opens no brief,
    // so it must not destroy the pointer to the one the user opened last. (The bare
    // /brief redirect and the grid's restore read it.)
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("cf:brief") ?? "null")?.id).toBe("camp"),
    );
    // …and camp's unsaved work is untouched. Getting here does not always follow the
    // unsaved-changes prompt — from any other view there is no mounted editor to call
    // itself dirty — so deleting the draft would be destroying work nobody was asked
    // about, and D11 recovery exists to keep exactly this.
    expect(localStorage.getItem("cf:draft:camp")).not.toBeNull();
  });

  test("saving on the blank route stops the URL calling it new", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );

    await fillValidDraft(user, "fresh");
    await saveVia(user, "Save");

    // D37: the URL is the source of truth for which brief is open — otherwise a
    // reload would blank the brief that was just saved
    await waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/brief/fresh"));
  });

  // Corrected for D35/D41: "Apply to run" is retired and the chip has two states.
  // What the old test pinned — that committing the draft retires the unapplied badge —
  // is now pinned by Save, and the badge it retired ("Draft not applied") is asserted
  // to exist nowhere.
  test("saving returns the chip to Saved, and 'Draft not applied' exists nowhere", async () => {
    const user = userEvent.setup();
    // the PUT/POST echoes what was sent, so the stored snapshot matches the draft
    // and the chip can actually read clean
    routes({ post: (_url, body) => json({ file: "fresh.yaml", brief: body, revision: "r1" }) });
    renderWithRun(<NewEditor />);

    // Corrected with the pristine-chip fix: an untouched editor holds a blank form,
    // so the chip has nothing to report yet — it appears once the draft has content.
    await fillValidDraft(user);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(screen.queryByText("Draft not applied")).toBeNull();
    await saveVia(user, "Save");
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });

  test("Cancel leaves the editor for the grid through the dirty guard, and a refused prompt keeps the draft", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await user.type(screen.getByLabelText("Headline"), " edited");
    await user.click(screen.getByRole("button", { name: messages.editorCancel }));

    // D40: the dirty guard owns the one question — the ConfirmDialog is the prompt,
    // exactly one, and Leave is consent to leave for the grid.
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(within(dialog).getByRole("button", { name: "Leave" })).toBeTruthy();

    // A refused Cancel changes nothing: no navigation, the draft still on screen.
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(nextMock().router.push).not.toHaveBeenCalledWith("/grid");
    expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Hi edited");
  });

  test("a clean editor's Cancel reaches the grid without prompting", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await user.click(screen.getByRole("button", { name: messages.editorCancel }));
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
  });

  test("Revert restores the last saved state, after asking through the replace confirmation", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await user.type(screen.getByLabelText("Headline"), " edited");
    expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Hi edited");

    // D40: Revert is the destructive half of the old Discard, so it confirms first —
    // through the editor's replace dialog (the shell's "Unsaved edits" pattern) since
    // window.confirm retired. Exactly one prompt.
    await user.click(screen.getByText("⋯"));
    await user.click(screen.getByText(messages.editorRevert));
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(screen.getAllByRole("dialog", { name: "Unsaved edits" })).toHaveLength(1);
    await user.click(within(prompt).getByRole("button", { name: messages.confirmDialogDiscard }));

    // The edit is thrown away and the saved state is back on screen.
    await waitFor(() =>
      expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Hi"),
    );
  });

  test("a clean editor's Revert acts without asking", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    // Nothing unsaved (loaded, unedited): the replace confirmation never opens, and
    // the saved state is what was on screen anyway.
    await user.click(screen.getByText("⋯"));
    await user.click(screen.getByText(messages.editorRevert));
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
    expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Hi");
  });

  test("a refused Revert changes nothing", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await user.type(screen.getByLabelText("Headline"), " edited");
    await user.click(screen.getByText("⋯"));
    await user.click(screen.getByText(messages.editorRevert));

    // the refusal (Stay) is pointed at the REVERT's confirmation, and it is inert
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(prompt).getByRole("button", { name: messages.confirmDialogStay }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull());
    // The refusal held: the draft keeps the edit the user declined to throw away.
    expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Hi edited");
  });

  test("a second replace gesture while the question stands never stacks a second prompt", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );
    await user.type(screen.getByLabelText("Headline"), " edited");

    await user.click(screen.getByText("⋯"));
    await user.click(screen.getByText(messages.editorRevert));
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(screen.getAllByRole("dialog", { name: "Unsaved edits" })).toHaveLength(1);

    // Triggering again while one question stands asks nothing more (DESIGN.md §5):
    // the same prompt remains, and the one answer runs the action.
    await user.click(screen.getByText("⋯"));
    await user.click(screen.getByText(messages.editorRevert));
    expect(screen.getAllByRole("dialog", { name: "Unsaved edits" })).toHaveLength(1);

    await user.click(within(prompt).getByRole("button", { name: messages.confirmDialogDiscard }));
    await waitFor(() =>
      expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Hi"),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull());
  });

  test("the recovery draft is not resurrected by autosave after a Revert (L1)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    // Type an edit (autosaved under the brief's draft key), then revert it.
    await user.type(screen.getByLabelText("Headline"), " edited");
    await waitFor(() => expect(localStorage.getItem("cf:draft:camp")).not.toBeNull());
    const autosaved = JSON.parse(localStorage.getItem("cf:draft:camp") ?? "null");
    expect(autosaved.state.campaignMessage).toBe("Hi edited");

    await user.click(screen.getByText("⋯"));
    await user.click(screen.getByText(messages.editorRevert));
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(prompt).getByRole("button", { name: messages.confirmDialogDiscard }));
    await waitFor(() =>
      expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Hi"),
    );

    // L1: the reverted state is not pristine, so autosave refills the key — with the
    // REVERTED content, never the discarded edit. (The old code purged here and
    // autosave immediately rewrote it: a no-op fight that this assertion pins.)
    await waitFor(() => {
      const draft = JSON.parse(localStorage.getItem("cf:draft:camp") ?? "null");
      expect(draft?.state?.campaignMessage).toBe("Hi");
    });
  });

  test("a Revert of a never-saved draft purges its recovery copy (L1, new source)", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );
    await fillValidDraft(user, "typed");

    // autosaved under the new draft's temp-id key. (The suite's localStorage is the
    // in-memory stand-in from vitest.setup, whose keys are read via key(i), not
    // Object.keys.)
    await waitFor(() => {
      const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
      expect(keys.filter((k) => k.startsWith("cf:draft:"))).toHaveLength(1);
    });

    await user.click(screen.getByText("⋯"));
    await user.click(screen.getByText(messages.editorRevert));
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(prompt).getByRole("button", { name: messages.confirmDialogDiscard }));

    // Reverting a new source mints a fresh temp id and leaves the editor pristine, so
    // autosave will not rewrite anything: the purge is what keeps the discarded edits
    // from lingering in storage forever.
    await waitFor(() => {
      const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
      expect(keys.filter((k) => k.startsWith("cf:draft:"))).toEqual([]);
    });
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("");
  });

  test("touching the same field twice does not churn the touched set", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    // Blur the same field twice: the second pass takes the "already touched" path.
    const region = screen.getByLabelText("Target Region");
    await user.clear(region);
    fireEvent.blur(region);
    fireEvent.blur(region); // the second pass takes the "already touched" path
    expect(await screen.findByText(messages.targetRegion)).toBeTruthy();
  });

  test("an error chip scrolls to its section", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    // The editor opens on the shell's active brief, which is valid — clear a required
    // field so Identity actually has something to report.
    await user.clear(screen.getByLabelText("Target Region"));
    // D1: nothing is red until the field is touched or an attempt is made. Blurring the
    // field is what a user does next, and it is what makes the chip appear.
    await user.tab();

    // "Identity" labels a table-of-contents button too, and both carry a count badge —
    // so pick the chip out of the ErrorStrip by its pill styling.
    await screen.findAllByRole("button", { name: /Identity/ });
    const strip = Array.from(document.querySelectorAll<HTMLElement>("button.rounded-full")).find(
      (b) => /Identity/.test(b.textContent ?? ""),
    ) as HTMLElement;
    expect(strip).toBeTruthy();
    const section = document.getElementById("identity") as HTMLElement;
    const scrollIntoView = vi.fn();
    section.scrollIntoView = scrollIntoView;

    await user.click(strip);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  test("the Policy chip now scrolls to a real section", async () => {
    const user = userEvent.setup();
    // E2.2 gives randomized briefs a policy panel, so this chip finally has a target.
    const randomized = {
      file: "rand.yaml",
      revision: "r1",
      brief: {
        ...brief("rand"),
        mode: "variation",
        variation: {
          count: 0,
          axes: {
            layout: ["headline-top"],
            tone: ["bold"],
            background: { source: ["procedural"] },
            paletteShift: [0],
          },
        },
      },
    };
    routes({ list: () => json({ briefs: [randomized] }) });
    renderWithRun(<Editor id="rand" />);

    const section = await waitFor(() => {
      const el = document.querySelector('[data-section="policy"], #policy');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const scrollIntoView = vi.fn();
    section.scrollIntoView = scrollIntoView;

    const chip = Array.from(document.querySelectorAll<HTMLElement>("button.rounded-full")).find(
      (b) => /Policy/.test(b.textContent ?? ""),
    ) as HTMLElement;
    expect(chip).toBeTruthy();
    await user.click(chip);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  test("the Motion chip scrolls to the motion controls, which now exist", async () => {
    const user = userEvent.setup();
    // E2.3: motion errors finally have a panel — the chip's scroll target is real.
    const motion = {
      file: "clip.yaml",
      revision: "r1",
      brief: {
        ...brief("clip"),
        output: { formats: ["static", "motion"], platforms: ["linkedin"] },
      },
    };
    routes({ list: () => json({ briefs: [motion] }) });
    renderWithRun(<Editor id="clip" />);

    const chip = await waitFor(() => {
      const found = Array.from(document.querySelectorAll<HTMLElement>("button.rounded-full")).find(
        (b) => /Motion/.test(b.textContent ?? ""),
      );
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    const section = await waitFor(() => {
      const el = document.querySelector('[data-section="motion"], #motion');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    const scrollIntoView = vi.fn();
    section.scrollIntoView = scrollIntoView;

    await user.click(chip);
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  test("unsaved edits come back when the brief they belong to is reopened", async () => {
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });

    // what the auto-save would have written while editing "camp"
    const edited = fromBrief(brief("camp") as never, { file: "camp.yaml", revision: "r1" });
    saveDraftToStorage({ ...edited, campaignMessage: "unsaved work" });

    // D37/H6: the draft is keyed to the route's id, so arriving at /brief/camp —
    // the way a reload does — finds the recovery copy once the brief has loaded.
    renderWithRun(<Editor id="camp" />);

    await waitFor(() =>
      expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("unsaved work"),
    );
  });

  test("a draft survives a reload at the same route (H6)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });

    const first = renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );
    await user.type(screen.getByLabelText("Headline"), " edited");
    await waitFor(() => expect(localStorage.getItem("cf:draft:camp")).not.toBeNull());
    first.unmount();

    // The reload: a fresh provider, a fresh editor, the same route.
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Hi edited"),
    );
  });

  test("declining the prompt keeps the current draft when selecting another brief", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1"), entry("other", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await user.type(screen.getByLabelText("Headline"), "!");

    await user.click(screen.getAllByText("camp")[0]);
    await user.click(await screen.findByText("other"));

    // The guard's question is the shell's own dialog; Stay refuses it.
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(prompt).getByRole("button", { name: messages.confirmDialogStay }));

    // The refused navigation went nowhere: the push never happened, so the route
    // still names camp and the draft (with its edit) is untouched on screen.
    expect(nextMock().router.push).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp");
    expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("Hi!");
  });

  test("declining the prompt keeps the current draft when starting a new brief", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await user.type(screen.getByLabelText("Headline"), "!");

    await user.click(screen.getAllByText("camp")[0]);
    await user.click(screen.getAllByText("New brief...").slice(-1)[0]);

    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(dialog).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));

    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp");
  });

  // Corrected for D35: "Apply to run" is retired; Save and Save as… are the verbs
  // that carry the refusal now.
  test("Save and Save as… refuse an invalid draft", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);

    // Wait for the route's brief to land first: clearing a field the load is
    // about to repopulate leaves the draft valid again and the buttons enabled.
    await waitForEditorReady();
    await user.clear(screen.getByLabelText("Target Region"));

    // D3: the verbs stay pressable — a dead button cannot explain itself. Pressing one
    // is how the user asks what is wrong, so each refuses out loud instead: nothing is
    // written, and the errors that were hidden until now become visible.
    // Re-query inside the assertion — React replaces these nodes on re-render, so a
    // reference captured beforehand can be stale by the time the draft turns invalid.
    expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );

    // Save is the verb itself now (one press); Save as… sits in the overflow.
    await saveVia(user, "Save");
    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "elsewhere");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );

    // both refused: no write left the page, and the refusal is on screen
    expect(writes(calls)).toEqual([]);
    expect(screen.getByText(messages.targetRegion)).toBeTruthy();
  });

  test("Save refuses a click destination the API would refuse, and writes nothing (HL5b)", async () => {
    // The API's boundary refuses a destination that is not an absolute URL
    // (load-brief.ts's validateClickDestination). Save must refuse the same thing:
    // otherwise the operator sees an inline error, saves anyway, and the server
    // rejects the brief. The structural validation now carries the destination.
    const user = userEvent.setup();
    const calls = routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );

    await fillValidDraft(user);
    await user.type(screen.getByLabelText(messages.clickDestinationLabel), "example.com/landing");

    await saveVia(user, "Save");

    expect(writes(calls)).toEqual([]);
    expect(
      screen.getByText(
        messages.clickDestinationInvalid(clickDestinationProblem("example.com/landing")!),
      ),
    ).toBeTruthy();
  });

  test("Save as… onto an existing id asks before overwriting, and honours a refusal", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => false);
    const calls = routes({ list: () => json({ briefs: [entry("taken", "r1")] }) });
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );

    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "taken");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );

    // The pre-flight check knows the id is taken: the attempt writes nothing and
    // the overwrite dialog asks (D9 — the visible decision, never an auto-resend).
    const prompt = await screen.findByRole("dialog", { name: messages.saveAsOverwriteTitle });
    await user.click(within(prompt).getByRole("button", { name: messages.confirmCancel }));

    // The refusal held: no write left the page, and the Save-as dialog stands
    // ready to answer differently.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(screen.getByLabelText("New brief id")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: messages.saveAsOverwriteTitle })).toBeNull();
  });

  test("accepting the overwrite retries with ?replace=1", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("taken", "r1")] }) });
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );

    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "taken");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );

    // the dialog is the decision point; the confirm is what sends the overwrite
    const prompt = await screen.findByRole("dialog", { name: messages.saveAsOverwriteTitle });
    await user.click(within(prompt).getByRole("button", { name: messages.saveAsOverwriteConfirm }));

    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.url).toContain("replace=1"));
  });

  test("a double activation of the overwrite confirm posts once", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("taken", "r1")] }) });
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );

    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "taken");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );

    const prompt = await screen.findByRole("dialog", { name: messages.saveAsOverwriteTitle });
    const confirm = within(prompt).getByRole("button", { name: messages.saveAsOverwriteConfirm });
    // Two activations in the same frame: `saving` has not flushed, so a state
    // check would still let both through. The synchronous ref is what collapses
    // them to one write.
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => expect(writes(calls).length).toBe(1));
    expect(writes(calls)[0].url).toContain("replace=1");
  });

  test("a 409 from a brief that appeared since the list was fetched offers the same overwrite", async () => {
    const user = userEvent.setup();
    let posts = 0;
    const calls = routes({
      post: () => {
        posts += 1;
        return posts === 1
          ? json({ error: "already exists" }, 409)
          : json({ file: "copy.yaml", brief: brief("copy") }, 201);
      },
    });
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );

    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );

    // the first attempt posted WITHOUT replace; its 409 opens the same dialog the
    // pre-flight check uses — one decision point, whichever way the collision was found
    await waitFor(() => expect(posts).toBe(1));
    const prompt = await screen.findByRole("dialog", { name: messages.saveAsOverwriteTitle });
    expect(calls.filter((c) => c.method === "POST")[0].url).not.toContain("replace=1");

    await user.click(within(prompt).getByRole("button", { name: messages.saveAsOverwriteConfirm }));
    await waitFor(() => expect(posts).toBe(2));
    expect(calls.filter((c) => c.method === "POST")[1].url).toContain("replace=1");
  });

  test("refusing the 409 overwrite leaves the copy unwritten", async () => {
    const user = userEvent.setup();
    let posts = 0;
    const calls = routes({
      post: () => {
        posts += 1;
        return json({ error: "already exists" }, 409);
      },
    });
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );

    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );

    const prompt = await screen.findByRole("dialog", { name: messages.saveAsOverwriteTitle });
    await user.click(within(prompt).getByRole("button", { name: messages.confirmCancel }));

    await waitFor(() => expect(posts).toBe(1));
    expect(calls.some((c) => c.method === "POST" && c.url.includes("replace=1"))).toBe(false);
    expect(screen.getByLabelText("New brief id")).toBeTruthy();
  });

  test("neither Escape nor Cancel dismisses the overwrite dialog while the retry write is in flight", async () => {
    const user = userEvent.setup();
    // The listing knows the id is taken, so the dialog opens without a write; the
    // confirm's retry POST never answers.
    routes({
      list: () => json({ briefs: [entry("taken", "r1")] }),
      post: () => new Promise<Response>(() => {}),
    });
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );

    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "taken");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );

    const prompt = await screen.findByRole("dialog", { name: messages.saveAsOverwriteTitle });
    await user.click(within(prompt).getByRole("button", { name: messages.saveAsOverwriteConfirm }));
    expect(screen.getByRole("dialog", { name: messages.saveAsOverwriteTitle })).toBeTruthy();

    // #163's saving guard: a dismissal mid-write would hand the user an editable
    // page whose pending adoption is about to discard their edits.
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: messages.saveAsOverwriteTitle })).toBeTruthy();
  });

  test("a non-409 Save as… failure is reported", async () => {
    const user = userEvent.setup();
    routes({ post: () => json({ error: "disk full" }, 500) });
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );

    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );

    expect(await screen.findByText(/disk full/)).toBeTruthy();
  });

  test("a route brief is re-attached to its file when the listing knows it", async () => {
    const calls = routes({
      list: () => json({ briefs: [entry("summer-hydration-2026", "rev-live")] }),
    });
    renderWithRun(<Editor id="summer-hydration-2026" />);

    // the route's brief arrives with the entry's file identity, so the editor can
    // save conditionally rather than as a new draft
    await waitFor(() =>
      expect(screen.getByLabelText("Campaign Name").hasAttribute("readonly")).toBe(true),
    );

    const user = userEvent.setup();
    await saveVia(user, "Save");
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.url).toContain("revision=rev-live"),
    );
  });

  test("the headline pool drawer opens from Copy and closes again", async () => {
    const user = userEvent.setup();
    const randomized = {
      file: "rand.yaml",
      revision: "r1",
      brief: {
        ...brief("rand"),
        mode: "variation",
        variation: {
          count: 4,
          axes: {
            layout: ["headline-top"],
            tone: ["bold"],
            background: { source: ["procedural"] },
            paletteShift: [0],
          },
        },
      },
    };
    routes({ list: () => json({ briefs: [randomized] }) });
    renderWithRun(<Editor id="rand" />);
    await waitFor(() =>
      expect(document.querySelector('[data-section="policy"], #policy')).toBeTruthy(),
    );

    // the drawer is only reachable from the Copy section, and only for a randomized brief
    expect(screen.queryByText("Headline Pool")).toBeNull();
    await user.click(screen.getByText("Manage Headline Pool"));
    expect(await screen.findByText("Headline Pool")).toBeTruthy();

    await user.click(screen.getByText("Close"));
    await waitFor(() => expect(screen.queryByText("Headline Pool")).toBeNull());
  });

  test("the view flows and the shell scrolls it, like every other view; the bar sticks inside that", async () => {
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    const { container } = renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();
    const root = container.firstElementChild as HTMLElement;
    // no forced height and no inner scroller: the shell's main container is the one
    // that scrolls, so /brief behaves like /grid instead of scrolling inside itself
    expect(root.className).not.toMatch(/\bh-full\b/);
    expect(root.querySelector(".overflow-y-auto:not(.sticky)")).toBeNull();
    const bar = screen.getByTestId("action-bar");
    // U8: the bar floats like the grid's pipeline bar, and stays floating. `sticky`
    // pins it to the bottom of the column's own scroll box; `absolute` would anchor it
    // to the content and let a long brief scroll it off screen, and `fixed` would pin
    // it to the viewport over the 320px sidebar — the bug #79 fixed once already.
    expect(bar.className).toMatch(/\bsticky\b/);
    expect(bar.className).not.toMatch(/\babsolute\b/);
    expect(bar.className).not.toMatch(/\bfixed\b/);
    expect(root.contains(bar)).toBe(true);
  });

  test("the policy accordion counts its issues, singular and plural", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();
    await user.click(screen.getByText("Randomized"));

    // one bad number → one issue; a second → two. Numbers, not axes: an axis cannot
    // be emptied any more (see the guard below), so it can no longer be an error.
    // the seed lives behind the Advanced door (D6), and the Field label wraps both the
    // input and its Pick button, so the input is addressed by role
    await user.click(await screen.findByRole("button", { name: "Advanced" }));
    await user.type(await screen.findByRole("spinbutton", { name: "Seed" }), "-1");
    // W4.1 surfaces the same single issue twice on purpose: the outline's "Variation
    // Policy" row and the accordion's aside both carry the ErrorPill, so this is a
    // plural surface, not a count of places — assert the number of issues, not nodes.
    await waitFor(() => expect(screen.getAllByLabelText("1 issue").length).toBeGreaterThan(0));
    expect(screen.queryAllByLabelText("2 issues")).toHaveLength(0);
    // Count, Min distance and the coverage floors are bounded controls that cannot be
    // driven out of range, so the second issue comes from emptying the ratio axis.
    for (const ratio of ["1:1", "9:16", "16:9"]) {
      await user.click(screen.getByRole("button", { name: ratio }));
    }
    await waitFor(() => expect(screen.getAllByLabelText("2 issues").length).toBeGreaterThan(0));
  });

  test("an axis keeps its last option — deselecting it would draw nothing", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();
    await user.click(screen.getByText("Randomized"));

    // turn the layout axis down to its last option, then press that one: the guard
    // holds it selected rather than letting the draw collapse to an axis with no values.
    const card = async (name: string) =>
      (await screen.findByRole("button", { name })) as HTMLButtonElement;
    await user.click(await card("headline-top"));
    const last = await card("headline-bottom");
    expect(last.getAttribute("aria-pressed")).toBe("true");
    await user.click(last);
    expect((await card("headline-bottom")).getAttribute("aria-pressed")).toBe("true");
    // and with the axis intact the panel reports nothing wrong
    expect(screen.queryByLabelText(/issue/)).toBeNull();
  });

  test("the mode toggle switches between classic and randomized", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<Editor />);

    // the section heading, not the inner "Treatments (n)" counter
    const sectionHeading = () => screen.queryByRole("heading", { name: /4 · Treatments/ });
    expect(sectionHeading()).toBeTruthy();
    await user.click(screen.getByText("Randomized"));
    await waitFor(() => expect(sectionHeading()).toBeNull());
    await user.click(screen.getByText("Classic"));
    await waitFor(() => expect(sectionHeading()).toBeTruthy());
  });
});

describe("BriefPage — capabilities and motion", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  const motionToggle = () => screen.getByRole("button", { name: "motion" }) as HTMLButtonElement;

  test("a 'not probed' snapshot is retried — the retry's verdict, not the snapshot, gates motion", async () => {
    let calls = 0;
    routes({
      capabilities: () => {
        calls += 1;
        return calls <= 1
          ? json({ motion: false, reason: "not probed" })
          : json({ motion: false, reason: "no ffmpeg" });
      },
    });
    renderWithRun(<Editor />);

    await waitFor(() => expect(calls).toBe(2));
    await waitFor(() => expect(motionToggle().disabled).toBe(true));
    expect(screen.getByText(messages.formatsMotionUnavailable)).toBeTruthy();
  });

  test("a probe that never settles leaves motion ungated rather than falsely unavailable", async () => {
    const user = userEvent.setup();
    let calls = 0;
    routes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      capabilities: () => {
        calls += 1;
        return json({ motion: false, reason: "not probed" });
      },
    });
    renderWithRun(<Editor id="camp" />);

    // the initial call plus the bounded retries, and then it gives up
    await waitFor(() => expect(calls).toBe(4));
    await new Promise((r) => setTimeout(r, 120));
    expect(calls).toBe(4);

    // "not probed" is not a verdict: committing it would report a false negative with
    // a meaningless reason, so the editor stays ungated and the API refuses at run time.
    // Classic mode gates Video by the mode rule, so exercise the capability path on a
    // Randomized draft where the probe verdict is the only thing that could gate it.
    await waitForEditorReady();
    await user.click(screen.getByText("Randomized"));
    await waitFor(() => expect(motionToggle().disabled).toBe(false));
    expect(screen.queryByText(/not probed/)).toBeNull();
  });

  test("Save carries the same motion refusal that a committed draft owes (D7)", async () => {
    const user = userEvent.setup();
    const motionBrief = {
      file: "clip.yaml",
      revision: "r1",
      brief: {
        ...brief("clip"),
        mode: "variation",
        // a complete motion policy: kinds and durations present, so the only thing
        // wrong with this brief on this host is that the host cannot run it
        variation: {
          count: 4,
          axes: {
            layout: ["headline-top"],
            tone: ["bold"],
            background: { source: ["procedural"] },
            paletteShift: [0],
            motion: ["ken-burns-in"],
            duration: [6],
          },
        },
        output: { formats: ["static", "motion"], platforms: ["linkedin", "instagram-reel"] },
      },
    };
    routes({
      list: () => json({ briefs: [motionBrief] }),
      capabilities: () => json({ motion: false, reason: "no ffmpeg" }),
      // the real PUT stores and returns the parsed body it was sent — echo it (see the
      // matching correction in "Save carries the same motion refusal")
      put: (_url, body) => json({ file: "clip.yaml", brief: body, revision: "r1" }, 200),
    });
    renderWithRun(<Editor id="clip" />);

    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("clip"),
    );
    // Under per-card gating (L4.4), motion kinds remain operable; the video format card
    // carries the capability gate description
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "ken-burns-in" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(motionToggle().disabled).toBe(false);

    // D7: the brief is unrunnable here but still savable, so Save & apply is enabled —
    // and having applied it, it owes the user the same reason Apply gives.
    const save = screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    await saveVia(user, "Save");

    // the Output section already shows this as a field error; the notice is the
    // separate status the action bar owes after applying
    await waitFor(() => expect(editorStatuses()).toHaveLength(1));
    expect(editorStatuses()[0].textContent).toBe(messages.statusApplyRefusal);
  });

  test("the capabilities are refetched when the window regains focus", async () => {
    const user = userEvent.setup();
    let calls = 0;
    routes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      capabilities: () => {
        calls += 1;
        return calls === 1 ? json({ motion: true }) : json({ motion: false, reason: "no ffmpeg" });
      },
    });
    renderWithRun(<Editor id="camp" />);

    await waitFor(() => expect(calls).toBe(1));
    // Classic mode gates Video at the format card, so move to Randomized where the
    // probe verdict is the only gate before testing the focus-triggered refetch.
    await waitForEditorReady();
    await user.click(screen.getByText("Randomized"));
    await waitFor(() => expect(motionToggle().disabled).toBe(false));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(motionToggle().disabled).toBe(true));
  });

  test("a capabilities answer arriving after unmount is ignored", async () => {
    let answer: ((response: Response) => void) | undefined;
    vi.mocked(globalThis.fetch).mockImplementation((url) => {
      if (String(url) === `${API}/campaigns/capabilities`) {
        return new Promise<Response>((resolve) => {
          answer = resolve;
        });
      }
      return Promise.resolve(json({ halted: false, assets: [], log: null }));
    });
    const { unmount } = renderWithRun(<Editor />);
    unmount();

    answer?.(json({ motion: false, reason: "no ffmpeg" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(0);
  });

  test("a motion brief authored from scratch saves with its motion policy (host with motion)", async () => {
    const user = userEvent.setup();
    const calls = routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );
    await fillValidDraft(user);
    await user.click(screen.getByText("Randomized"));

    // request motion, then customize kind, duration and a packaging platform
    await user.click(screen.getByRole("button", { name: "motion" }));
    // motion is seeded with all kinds and 6s duration (D9)
    // deselect non-ken-burns kinds
    await user.click(screen.getByRole("button", { name: "ken-burns-out" }));
    await user.click(screen.getByRole("button", { name: "headline-rise" }));
    await user.click(screen.getByRole("button", { name: "accent-wipe" }));
    await user.click(screen.getByRole("button", { name: "instagram-reel" }));

    await saveVia(user, "Save");
    const post = await waitFor(() => {
      const call = calls.find((c) => c.method === "POST" && c.url.includes("/campaigns/briefs"));
      expect(call).toBeTruthy();
      return call!;
    });
    expect(post.body).toMatchObject({
      mode: "variation",
      variation: { axes: { motion: ["ken-burns-in"], duration: [6] } },
      output: {
        formats: ["static", "motion"],
        platforms: ["instagram-feed", "linkedin", "x", "instagram-reel"],
      },
    });
  });

  test("motion without a kind or a duration blocks Save, and the error reaches its input", async () => {
    const user = userEvent.setup();
    const calls = routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );
    await fillValidDraft(user);
    await user.click(screen.getByText("Randomized"));
    await user.click(screen.getByRole("button", { name: "motion" }));

    // Deselect all seeded motion kinds and remove seeded duration
    await user.click(screen.getByRole("button", { name: "ken-burns-in" }));
    await user.click(screen.getByRole("button", { name: "ken-burns-out" }));
    await user.click(screen.getByRole("button", { name: "headline-rise" }));
    await user.click(screen.getByRole("button", { name: "accent-wipe" }));
    await user.click(screen.getByRole("button", { name: "Remove duration 6 s" }));

    expect(screen.getByText(messages.motion)).toBeTruthy();
    expect(screen.getByText(messages.duration)).toBeTruthy();
    // D3: the verb is never disabled — it stays live and refuses when pressed.
    expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    // The control named "Save" opens the menu; the verb a user actually presses is inside
    // it. Clicking only the menu button proved nothing here — this assertion passed with
    // the refusal removed entirely, because opening a menu never writes.
    await saveVia(user, "Save");
    expect(writes(calls)).toEqual([]);
  });

  /**
   * X30: the CI-only "Test timed out in 5000ms" on this suite's four slowest tests
   * (this one, "a motion brief authored from scratch...", "Save refuses a click
   * destination...", "a motion brief on a host without motion...") is duration, not
   * flakiness — same SHA, 4m20s on the push run and 9m51s on the PR run. The html
   * weight meter (HL5c/HL5f/HL5e) was the first suspect; it is innocent here (none of
   * these four select a platform whose `formats` include `html`, so
   * `htmlWeightReading` returns before ever calling `assembleHtml` — measured 0 calls
   * across all four, and the timing is identical on `origin/main~6`, before the meter
   * existed at all). The real cost: every dispatch in the "everything" presentation
   * re-renders the whole large tree, and `BriefEditor` used to pay THREE full commits
   * per interaction — the dispatch's own, plus a second because the validate-on-change
   * effect (errors/warnings/blockedAt) mirrored `state` into `useState` with `setState`
   * calls of its own, plus a third from the dirty-flag effect. The second commit is
   * pure waste: `errors`/`warnings`/`blockedAt` are pure functions of `state` (and the
   * brief id list) with no other writer, so deriving them with `useMemo` folds that
   * commit into the render `dispatch` already scheduled. This is a work-count
   * assertion, not a wall-clock one — the runner that produced the CI regression is
   * exactly the one a wall-clock assertion would be flaky on.
   */
  /**
   * CI split on this SHA (push run failed, PR run on the same commit passed):
   * once Randomized + motion + a named product make the draft's look fully
   * specified, the rail now paints here too (D141 — Everything is no longer
   * excluded), and `usePreviewFrame`'s debounced fetch resolves and commits
   * once, ~`PREVIEW_FRAME_DEBOUNCE_MS` after whichever click most recently
   * changed the look. That commit is the one-time cost of painting a
   * creative at all — inherent, and already covered by CC2's own
   * acceptance criteria — not a per-toggle cost. Left unsettled, its landing
   * inside a measured window is a race: instrumented locally (20 runs, this
   * test's own Profiler plus a `/campaigns/preview-frame` call counter),
   * every run showed exactly one extra commit arriving ~300-500ms after the
   * setup clicks, always AFTER this file's fast local click resolves — which
   * is exactly why it passed here every time and only failed on a loaded CI
   * runner where a click's own processing can take long enough for the
   * timer to fire first. Settling past the debounce before each reset — not
   * raising the budget — makes the toggle's own two commits (D3-style: the
   * dispatch, plus the dirty-flag effect) the only thing left to count.
   */
  test("a single motion-kind toggle commits the editor at most twice, not three times (X30)", async () => {
    const user = userEvent.setup();
    routes({});
    let commits = 0;
    renderWithRun(
      <Profiler
        id="x30-commits"
        onRender={() => {
          commits += 1;
        }}
      >
        <NewEditor />
      </Profiler>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );
    await fillValidDraft(user);
    await user.click(screen.getByText("Randomized"));
    await user.click(screen.getByRole("button", { name: "motion" }));
    // Let the rail's own preview-frame fetch (triggered by the look becoming
    // fully specified above) resolve and commit before it can be counted
    // against a toggle it has nothing to do with.
    await new Promise((r) => setTimeout(r, 400));

    commits = 0;
    await user.click(screen.getByRole("button", { name: "ken-burns-in" }));
    // One user gesture is one state change (D3-style): the dispatch's own commit,
    // plus at most one more for the dirty-flag effect (`setDirty` in a context that
    // outlives the route) — never a third for a validation mirror that has no reason
    // to exist as its own commit.
    expect(commits).toBeLessThanOrEqual(2);
    // This click also changed the previewed motion kind, re-keying the fetch
    // (CC2) and scheduling another debounced request — settle it too before
    // the next measurement, for the same reason as above.
    await new Promise((r) => setTimeout(r, 400));

    commits = 0;
    await user.click(screen.getByRole("button", { name: "ken-burns-out" }));
    expect(commits).toBeLessThanOrEqual(2);
  });

  /**
   * X32 — X30 closed one of the shell's three commits per interaction (the
   * validate-on-change mirror) but explicitly left the dirty-flag effect's own
   * commit standing, and it never measured a keystroke that revisits an
   * already-touched field, only a fresh motion-kind click (above). Re-measured
   * directly with a `React.Profiler`, isolating each candidate in turn:
   *
   * - The dirty-flag round trip X30 flagged (`setDirty`'s cleanup running on every
   *   dep change, not only unmount, so an unrelated keystroke paid a false→true
   *   round trip through `EditorDirtyContext` even when the flag was already
   *   `true` on both sides) turned out not to cost an extra commit by itself:
   *   React's automatic batching already folds a cleanup-then-body pair from the
   *   SAME effect into one commit. Reverting the ref guard alone does not move
   *   this test. The fix is kept anyway — it halves the number of writes into a
   *   context with other subscribers (Header, Sidebar), which matters outside
   *   this Profiler's subtree even though it does not move this number — but it
   *   is not what this test pins.
   * - Same story for the panel-publishing effects' unconditional
   *   `return () => setPanels(null)` / `setTopPanels(null)`: a real null → JSX
   *   round trip on every state change, batched into one commit either way.
   *   Reverting it alone does not move this test either.
   * - The one BriefEditor inefficiency that DOES move this test:
   *   `handleMainBlur` called `setTouched((prev) => new Set(prev).add(key))`
   *   unconditionally, so re-blurring a field the user had already visited once
   *   (correcting an earlier field after filling the rest of the draft — a
   *   completely ordinary gesture, exercised below) built a fresh `touched`
   *   reference for zero semantic change. `visibleErrors` depends on `touched`,
   *   so that fresh reference republishes the top panels for nothing —
   *   `touchSectionFromEvent`, three lines above it, already had this exact
   *   guard. Verified directly: reverting just this guard turns this test's
   *   measured gesture from 3 commits to 5.
   *
   * N=3 is what remains, and it is not a BriefEditor effect at all: instrumented
   * every setState call BriefEditor's effects make (setDirty, setTopPanels,
   * setPanels, the D35 setDraftRun handoff, setTouched, setTouchedSections) and
   * confirmed each already bails out correctly on the measured gesture — the
   * third commit lands before this component's own `dispatch` runs, and before
   * any of them. A control confirms it is click-side, not keyboard-side: passing
   * `{ skipClick: true }` (so `userEvent.type` only fires keyboard events, no
   * pointer events, on an already-focused field) drops it straight to 2, matching
   * a click. `userEvent.type` always precedes typing with a click sequence
   * (mousedown/mouseup/click) to establish focus and caret position — modelling a
   * real user clicking into a field before typing — and that click is on a
   * controlled `<input>`, which pays a React-internal commit a button's click
   * never does. Not fixable without decontrolling the field, which would be a
   * correctness regression (D3's typed value would stop round-tripping through
   * validation) — out of scope for this lane. N=3 is the honest floor for
   * "click into a field, then type" — the shape every keystroke in this suite's
   * `fillValidDraft` actually takes.
   */
  test("a single keystroke into a text field commits the shell at most three times (X32)", async () => {
    const user = userEvent.setup();
    routes({});
    let commits = 0;
    renderWithRun(
      <Profiler
        id="x32-keystroke-commits"
        onRender={() => {
          commits += 1;
        }}
      >
        <NewEditor />
      </Profiler>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );
    await fillValidDraft(user);
    // Revisit a field fillValidDraft already touched once (Target Region, blurred
    // when fillValidDraft moved on to Target Audience) — the ordinary "go back and
    // fix an earlier field" gesture, and the one this test's fix is about.
    await user.type(screen.getByLabelText("Target Region"), "z");

    commits = 0;
    // Leaving Target Region again is the re-blur of an already-touched field this
    // fix targets; typing into Campaign Name is the keystroke being measured.
    await user.type(screen.getByLabelText("Campaign Name"), "q");
    expect(commits).toBeLessThanOrEqual(3);
  });

  /**
   * X32 — the dirty flag's ref-guarded effect must not change what the flag means,
   * only how often it republishes. Each assertion below would fail on a plausible
   * "optimization" the mutation manifest doesn't already cover: dropping the
   * unmount effect entirely (unmount would never clear it), initializing the ref to
   * `true` instead of `null` (the first real edit would be swallowed as a no-op),
   * or guarding on `state` identity instead of the derived boolean (a no-op edit,
   * which always produces a new `state` object, would incorrectly toggle it).
   */
  test("the dirty flag sets on a real edit, ignores a no-op edit, clears on save, and clears on unmount (X32)", async () => {
    const DirtyProbe = () => {
      const { isDirty } = useEditorDirty();
      return <span data-testid="dirty-probe">{isDirty ? "dirty" : "clean"}</span>;
    };
    const user = userEvent.setup();
    const calls = routes({});
    const view = renderWithRun(
      <>
        <DirtyProbe />
        <NewEditor />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );
    expect(screen.getByTestId("dirty-probe").textContent).toBe("clean");

    // A first real edit sets it.
    await fillValidDraft(user);
    expect(screen.getByTestId("dirty-probe").textContent).toBe("dirty");

    // An edit that changes nothing does not toggle it: replaying the value a field
    // already holds still dispatches a `patch` (a new `state` object), but
    // `isPristine`/`isDirtySinceSave` recompute to the same booleans as before, so
    // the flag must not flip off and back on.
    fireEvent.change(screen.getByLabelText("Campaign Name"), { target: { value: "fresh" } });
    expect(screen.getByTestId("dirty-probe").textContent).toBe("dirty");

    // A save clears it: the saved snapshot now matches the draft.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await saveVia(user, "Save");
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    await waitFor(() => expect(screen.getByTestId("dirty-probe").textContent).toBe("clean"));

    // Dirty again — an edit against the now-saved snapshot — then the route
    // unmounts (e.g. navigating away). The provider outlives the route, so the
    // flag must not keep a stale editor's answer prompting every later navigation.
    await user.type(screen.getByLabelText("Target Audience"), "!");
    expect(screen.getByTestId("dirty-probe").textContent).toBe("dirty");
    view.rerender(
      <ShellProviders>
        <DirtyProbe />
      </ShellProviders>,
    );
    expect(screen.getByTestId("dirty-probe").textContent).toBe("clean");
  });

  /**
   * X34 — its own nested `describe`, not a `beforeAll` loose in the parent
   * suite: a `beforeAll` failure (the reference build throws, or exceeds
   * `hookTimeout`) fails or skips every test in whatever suite it is attached
   * to, so scoping it to this one test's own describe means a broken fixture
   * here can only ever take out this one test — never the capability tests
   * around it. Model review (Qodo) on the PR that introduced this `beforeAll`
   * caught exactly that blast radius, plus a second problem: `view.unmount()`,
   * `vi.restoreAllMocks()`, and `localStorage.clear()` all ran only on the
   * success path, so a mid-hook failure could leave a mounted editor and a
   * live `fetch` spy behind for every later test in the file (the global
   * `afterEach` in `vitest.setup.ts` runs after each *test*, never after a
   * `beforeAll`). Both are fixed below with `try`/`finally`, proved by
   * temporarily breaking the reference build and confirming siblings still
   * pass and nothing leaks (recorded in the PR, not merely asserted here).
   */
  describe("fillValidDraft equivalence (X34)", () => {
    /**
     * `fillValidDraft` above no longer drives `userEvent.type` character by
     * character; each field gets one `fireEvent.click` (marks its section
     * touched, matching the click `userEvent.type` fires before every
     * keystroke), one `el.focus()` (moves real focus, which blurs whatever
     * was focused before — matching `touched`'s per-field mark and leaving
     * the last field focused exactly as typing does), and one
     * `fireEvent.change` (the final value). Three things could differ if that
     * shape were wrong, none of them visible in the saved draft alone: the
     * draft itself, which sections read as "touched" (gates whether an error
     * shows before Save is attempted), and which field is left focused. The
     * test below pins all three:
     *
     * (a) the saved brief — `toBrief` never sees intermediate frames or key
     *     order, only the value each field settles on, so the POST body is
     *     the honest comparison, as before.
     * (b) touched sections — there is no direct accessor, so this observes
     *     the one thing touching a section actually gates: after filling,
     *     make product 0's colour invalid through its plain hex `<Input>`
     *     (`fireEvent.change` only — no click, no blur, so `touched` itself
     *     never gains `product-0-color`) and check whether the error
     *     renders. It should, in both paths, purely because `fillValidDraft`
     *     already clicked *something* inside the Products section (Name,
     *     Logo Path) — if the fast path stopped clicking, this would go dark
     *     while (a) stayed green.
     * (c) focus — `document.activeElement` right after `fillValidDraft`
     *     returns, identified by its field key (`Field`'s `data-field-key`,
     *     not the node, since the two paths render separate trees), must be
     *     the last field typing leaves focused: the second product's Logo
     *     Path.
     *
     * The typed path — `typeFillValidDraftByHand`, the original, unconverted
     * character-by-character sequence — is the reference these three are
     * pinned against, and nothing else in this file reuses it. It used to run
     * a second time, live, inside the same test as the fast path, which made
     * this the single most expensive test in the file: on a loaded CI runner
     * (the regime X30/X32 measured and this lane fixed for the other four
     * historically slow tests) it timed out at 5000ms even though those four
     * now pass — see §36 (X34) in docs/planning/2026-09-10_the-unowned-gaps.md.
     * `beforeAll` below builds that reference exactly once instead. Web tests
     * now get `testTimeout: 15000` (X36, §40 of
     * docs/planning/2026-09-10_the-unowned-gaps.md); `hookTimeout` is
     * unchanged at Vitest's 10000ms default, so the hook has the smaller
     * budget, not double the test's. `beforeAll` is still the right place for
     * the one-time typed reference: it runs once for the whole describe
     * rather than inside every test's own budget. The typed path is still
     * what produces the reference (never a hand-written expectation), and
     * the actual `test()` below now pays only the fast path's cost, the same
     * as every other test that calls `fillValidDraft`.
     */
    const typeFillValidDraftByHand = async (
      user: ReturnType<typeof userEvent.setup>,
      id: string,
    ) => {
      await user.type(screen.getByLabelText("Campaign Name"), id);
      await user.type(screen.getByLabelText("Target Region"), "DE");
      await user.type(screen.getByLabelText("Target Audience"), "a");
      await user.type(screen.getByLabelText("Headline"), "Hi");
      let names = screen.getAllByLabelText("Name");
      if (names.length < 2) {
        await user.click(screen.getByRole("button", { name: "Add product" }));
        names = screen.getAllByLabelText("Name");
      }
      await user.type(names[0], "A");
      await user.type(names[1], "B");
      const logos = screen
        .getAllByLabelText("Logo Path")
        .filter((el) => el.tagName === "INPUT" && el.getAttribute("type") !== "file");
      await user.type(logos[0], "a.png");
      await user.type(logos[1], "b.png");
    };

    const observeFillValidDraft = async (
      fill: (user: ReturnType<typeof userEvent.setup>) => Promise<void>,
    ) => {
      // Isolation this render needs, whether it runs from `beforeAll` (before
      // the suite's own `beforeEach` has ever fired) or from the `test()`
      // below (after it has) — explicit here rather than relied on from
      // either side.
      localStorage.clear();
      localStorage.setItem("cf:brief-picked", "1");
      const user = userEvent.setup();
      const calls = routes({});
      const view = renderWithRun(<NewEditor />);
      // `finally`, not a plain trailing `unmount()`: a throw anywhere below
      // (a `waitFor` that never resolves, a label that moved) must still
      // unmount this render rather than leave it mounted for whatever runs
      // next — the one thing this function's caller cannot do on its behalf,
      // since `view` lives only in this closure.
      try {
        await waitFor(() =>
          expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
        );
        await fill(user);

        // (c) — captured before anything else moves focus (Save's own click included).
        const focusedFieldKey =
          (document.activeElement as HTMLElement | null)
            ?.closest("[data-field-key]")
            ?.getAttribute("data-field-key") ?? null;

        // (a)
        await saveVia(user, "Save");
        const post = await waitFor(() => {
          const call = calls.find((c) => c.method === "POST");
          expect(call).toBeTruthy();
          return call!;
        });

        // (b) — the hex text input, not the swatch buttons or the sr-only
        // colour picker: a plain `fireEvent.change` on it clicks and blurs
        // nothing, so this cannot mark `touched` or `touchedSections` itself.
        // Whatever makes the resulting error visible was already true
        // beforehand.
        const colorInputs = screen.getAllByLabelText(messages.productColorLabel);
        fireEvent.change(colorInputs[0], { target: { value: "not-a-color" } });
        const productsSectionWasTouched = screen.queryByText(messages.productColor) !== null;

        return { body: post.body, focusedFieldKey, productsSectionWasTouched };
      } finally {
        view.unmount();
      }
    };

    let typedReference: Awaited<ReturnType<typeof observeFillValidDraft>>;

    beforeAll(async () => {
      // The suite's own `beforeEach` (the parent describe) and the global one
      // (`vitest.setup.ts`, which spies `fetch` and seeds a benign default
      // implementation) have not run yet — `beforeAll` fires once, before the
      // first test's `beforeEach` chain — so `fetch` is not a spy yet here.
      // `routes()` inside `observeFillValidDraft` calls `.mockImplementation()`
      // on it and needs it to already be one.
      vi.spyOn(globalThis, "fetch");
      // `finally`, not a plain trailing pair of statements: if
      // `observeFillValidDraft` throws (its own `try`/`finally` above still
      // unmounts its render either way), the spy this hook installed and the
      // `localStorage` keys it seeded must not leak into every test that
      // runs after it in the file — this hook has no `afterEach` of its own
      // to undo them.
      try {
        typedReference = await observeFillValidDraft((user) =>
          typeFillValidDraftByHand(user, "fresh"),
        );
      } finally {
        // Put back what the global `afterEach` would have: nothing here
        // should leak into the first real test's own `beforeEach`/`routes()`
        // setup.
        vi.restoreAllMocks();
        localStorage.clear();
      }
    });

    test("fillValidDraft's fast path produces the same draft, touched sections, and focus the typed path produces (X34)", async () => {
      const fast = await observeFillValidDraft((user) => fillValidDraft(user, "fresh"));

      expect(fast.body).toEqual(typedReference.body);
      expect(fast.focusedFieldKey).toBe(typedReference.focusedFieldKey);
      expect(fast.focusedFieldKey).toBe("product-1-logo");
      expect(fast.productsSectionWasTouched).toBe(typedReference.productsSectionWasTouched);
      expect(fast.productsSectionWasTouched).toBe(true);
    });
  });

  test("a motion brief on a host without motion stays read-only, saves verbatim, and applies with the refusal (D12)", async () => {
    const user = userEvent.setup();
    const clip = {
      ...brief("clip"),
      mode: "variation",
      variation: {
        count: 8,
        seed: 3,
        minDistance: 2,
        coverage: { perProduct: 1, perRatio: 1 },
        axes: {
          layout: ["headline-top", "headline-bottom"],
          tone: ["bold", "subtle"],
          background: { source: ["procedural"] },
          paletteShift: [0, 0.1],
          motion: ["ken-burns-in", "headline-rise"],
          duration: [6],
        },
      },
      output: { formats: ["static", "motion"], platforms: ["instagram-feed", "instagram-reel"] },
    };
    const calls = routes({
      list: () => json({ briefs: [{ file: "clip.yaml", brief: clip, revision: "r1" }] }),
      capabilities: () => json({ motion: false, reason: "no ffmpeg" }),
      // the real PUT stores and returns the parsed body it was sent — echo it (see the
      // matching correction in "Save carries the same motion refusal")
      put: (_url, body) => json({ file: "clip.yaml", brief: body, revision: "r1" }, 200),
    });
    renderWithRun(<Editor id="clip" />);

    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("clip"),
    );

    // the probe's verdict lands and Video card shows capability description. Under per-card
    // gating (L4.4), motion kinds remain operable and the format toggle stays operable.
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "ken-burns-in" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(motionToggle().disabled).toBe(false);
    expect(screen.getByText(messages.formatsMotionUnavailable)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "ken-burns-in" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    const slider = screen.getByRole("slider", { name: "Duration 1 (seconds)" });
    expect(slider).toBeTruthy();
    expect(slider.getAttribute("aria-valuenow")).toBe("6");
    expect(
      (screen.getByRole("button", { name: "instagram-reel" }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // structurally valid ⇒ persistable: Save stays offered and keeps the fields verbatim
    const save = () => screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement;
    await waitFor(() => expect(save().disabled).toBe(false));
    await saveVia(user, "Save");
    const put = await waitFor(() => {
      const call = calls.find((c) => c.method === "PUT");
      expect(call).toBeTruthy();
      return call!;
    });
    expect(put.url).toContain("revision=r1");
    expect(put.body).toMatchObject({
      id: "clip",
      mode: "variation",
      variation: { axes: { motion: ["ken-burns-in", "headline-rise"], duration: [6] } },
      output: { formats: ["static", "motion"], platforms: ["instagram-feed", "instagram-reel"] },
    });

    // Corrected for D35: "Apply to run" is retired — Save is the verb that commits,
    // and having committed, it owes the user the same motion refusal Apply gave (D7).
    await waitFor(() => {
      expect(editorStatuses()).toHaveLength(1);
      expect(editorStatuses()[0].textContent).toBe(messages.statusApplyRefusal);
    });
  });

  test("an incompatible format/platform pair is reported in the editor, not only by the API", async () => {
    // static-only formats with a motion platform declared: the API would refuse at
    // parse time; the editor must say it first.
    const mismatched = {
      file: "odd.yaml",
      revision: "r1",
      brief: { ...brief("odd"), output: { formats: ["static"], platforms: ["instagram-reel"] } },
    };
    routes({ list: () => json({ briefs: [mismatched] }) });
    renderWithRun(<Editor id="odd" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("odd"),
    );

    expect(
      await screen.findByText(messages.platformsIncompatible("Instagram Reel", ["Video"])),
    ).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  test("an outline row scrolls its section into view and hands it focus", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    // happy-dom lays nothing out, so `getClientRects` is empty for every candidate and
    // the fallback in `outlineActivate` is what selects the target — the same fallback
    // `scrollToSection` relies on. Without it this handoff is unreachable, not merely
    // untested.
    Element.prototype.scrollIntoView = scrollIntoView;
    // A loaded, valid brief: the status line carries no section links, so the
    // outline's row is the only button named /Identity/.
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    const row = await screen.findByRole("button", { name: "Identity" });
    await user.click(row);
    expect(scrollIntoView).toHaveBeenCalled();
    const section = document.querySelector(
      '#identity, [data-section="identity"]',
    ) as HTMLElement | null;
    expect(section).not.toBeNull();
    expect(document.activeElement).toBe(section);
  });

  test("an outline row whose section has left the page does nothing", async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    const row = await screen.findByRole("button", { name: "Identity" });
    // Delete the target first: the row then has nothing to hand focus to. No
    // presentation unmounts a section any more (SG1), so the branch is reached
    // by removing the node — `focusSection` must still not throw.
    document.querySelectorAll('#identity, [data-section="identity"]').forEach((el) => el.remove());
    await user.click(row);
    expect(document.querySelector('#identity, [data-section="identity"]')).toBeNull();
    // Focus stays on the row the user pressed; nothing else is grabbed. (A click focuses
    // its own button, so the meaningful assertion is that no section took focus.)
    expect(document.activeElement).toBe(row);
  });
});

describe("BriefPage — the editor is one scrolling column (SG1 / SG-D2)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  /** A classic brief with every section filled in. */
  const complete = (id: string) => ({
    ...brief(id),
    output: { formats: ["static"], platforms: ["linkedin"] },
  });

  // D37: adopting a brief IS arriving at its route — wait for the route's brief to land.
  const adopt = async (_user: ReturnType<typeof userEvent.setup>, id: string) => {
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(id),
    );
  };

  /**
   * SG-D2, and the fact the whole lane rests on: `everything` already rendered
   * every section in one column, so retiring `guided` is a deletion and not a
   * rebuild. This is the positive form of the test the wizard's own suite
   * carried ("guided shows one section at a time"): every section is mounted at
   * once, there is no step chrome, and no presentation to choose.
   */
  test("every section is mounted at once, with no step chrome and no presentation toggle", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    for (const section of sectionOrder("brief")) {
      expect(document.getElementById(section)).toBeTruthy();
    }
    // No walk: no segbar landmark, no step card, no Next/Back, no step heading.
    expect(screen.queryByRole("navigation", { name: messages.segBarLabel })).toBeNull();
    expect(document.querySelector('[data-testid="step-card"]')).toBeNull();
    // Literals, because `messages.stepNext`/`stepBack` are deleted with the footer
    // that spoke them — the point is that no control by those names exists at all.
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    // The status chip is unconditional now: the StepHeader that used to announce
    // the step's own status is gone, so this row is the only place it is said.
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  /**
   * The presentation is no longer a choice, and `cf:presentation` is no longer a
   * key. A stale value from a returning operator's storage must not resurrect a
   * wizard that no longer exists — and nothing may write the key either.
   */
  test("a stale cf:presentation value changes nothing, and nothing writes the key", async () => {
    const user = userEvent.setup();
    localStorage.setItem("cf:presentation", "guided");
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    expect(document.getElementById("identity")).toBeTruthy();
    expect(document.getElementById("products")).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: messages.segBarLabel })).toBeNull();
    // Untouched: the editor neither read it nor rewrote it.
    expect(localStorage.getItem("cf:presentation")).toBe("guided");
  });

  /**
   * M7 — the Asset Bin drawer lives at the editor's root, not inside the section
   * that offers it. The original reason was the guided step card's permanent
   * transform, which made it the containing block for `fixed` descendants and
   * trapped the drawer's viewport-covering scrim; the card is gone, but a section
   * can still acquire a transform, so the placement is still the fix and still
   * worth pinning. happy-dom applies no layout, so this is the structural half —
   * the visual half is verified in a browser.
   */
  test("the Asset Bin drawer mounts outside the section that offers it (M7)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    await user.click(screen.getAllByRole("button", { name: messages.logoChooseFromBin })[0]);
    const drawer = await screen.findByRole("dialog", { name: "Asset Bin" });

    const products = document.getElementById("products") as HTMLElement;
    expect(products).toBeTruthy();
    expect(products.contains(drawer)).toBe(false);
  });

  test("picking an asset in the hoisted bin still fills the product's logo", async () => {
    const user = userEvent.setup();
    // The same fetch mock routes() installs, plus the bin's listing endpoint — the
    // hoisted drawer fetches against the brief's id exactly as it did in the section.
    vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (u.includes("/campaigns/assets")) {
        return Promise.resolve(
          json({ assets: [{ name: "brand-logo.png", size: 4096, type: "image/png" }] }),
        );
      }
      if (method === "GET" && u.startsWith(`${API}/campaigns/briefs`)) {
        return Promise.resolve(json({ briefs: [entry("ok", "r1")] }));
      }
      if (method === "GET" && u.includes("/campaigns/capabilities")) {
        return Promise.resolve(json({ motion: true }));
      }
      return Promise.resolve(json({}, 404));
    });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    await user.click(screen.getAllByRole("button", { name: messages.logoChooseFromBin })[0]);
    await screen.findByRole("dialog", { name: "Asset Bin" });
    await user.click(await screen.findByRole("button", { name: "Choose brand-logo.png" }));

    // the selection rode the hoisted drawer: the product's logo is the bin asset…
    const logos = () =>
      screen
        .getAllByLabelText("Logo Path")
        .filter((el) => el.tagName === "INPUT" && el.getAttribute("type") !== "file");
    await waitFor(() =>
      expect((logos()[0] as HTMLInputElement).value).toBe("assets/inputs/ok/brand-logo.png"),
    );
    // …and the drawer closed with the choice, the way the in-section drawer did.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Asset Bin" })).toBeNull());
  });

  /**
   * SG1's reveal contract: `reveal(section)` can no longer change a step, so it
   * must scroll the column — and stay scroll-only. This replaces the guided test
   * that asserted the opposite mechanism ("switches the step FIRST, then
   * scrolls"): the chip's section is already mounted, so the scroll is
   * synchronous and the deferred `pendingReveal` marker is gone.
   */
  test("an ErrorStrip chip scrolls its section in the column, and leaves focus alone", async () => {
    const user = userEvent.setup();
    const scroller = vi.fn();
    Element.prototype.scrollIntoView = scroller;
    // Products is invalid, so its chip is in the action bar's strip.
    const brokenProducts = {
      file: "prod.yaml",
      revision: "r1",
      brief: {
        ...brief("prod"),
        products: [{ id: "bad id", name: "A", primaryColor: "#1473E6", logoPath: "a.png", key: 0 }],
      },
    };
    routes({ list: () => json({ briefs: [brokenProducts] }) });
    renderWithRun(<Editor id="prod" />);
    await adopt(user, "prod");

    const chip = Array.from(document.querySelectorAll<HTMLElement>("button.rounded-full")).find(
      (b) => /Products/.test(b.textContent ?? ""),
    ) as HTMLElement;
    expect(chip).toBeTruthy();
    const section = document.getElementById("products") as HTMLElement;
    expect(section).toBeTruthy();
    scroller.mockClear();
    await user.click(chip);

    // The scroll ran on the section itself, once — not repeatedly, and not on a
    // step change. (`toHaveBeenCalled()` alone is this repo's known decorative
    // assertion, so the count and the receiver are both named.)
    expect(scroller).toHaveBeenCalledTimes(1);
    expect(scroller.mock.instances[0]).toBe(section);
    // The reveal stayed scroll-only: nothing grabbed focus for itself.
    expect(document.activeElement).not.toBe(section);
  });

  /**
   * The sidebar's Variation Policy accordion. `policy` is the one section the
   * column has never rendered: in `everything` it lived here, and the gate used
   * to read `mode === "variation" && presentation === "everything"` because the
   * Guided walk had a policy STEP. With the step gone the gate is the mode alone.
   */
  test("the policy sidebar renders for a variation brief, and not for a classic one", async () => {
    const user = userEvent.setup();
    const randomizedBrief = {
      ...complete("rand"),
      mode: "variation",
      variation: {
        count: 0,
        axes: {
          layout: ["headline-top"],
          tone: ["bold"],
          background: { source: ["procedural"] },
          paletteShift: [0],
        },
      },
    };
    routes({
      list: () =>
        json({
          briefs: [
            { file: "rand.yaml", revision: "r1", brief: randomizedBrief },
            entry("ok", "r2"),
          ],
        }),
    });
    renderWithRun(<Editor id="rand" />);
    await adopt(user, "rand");

    // The sidebar panel is the element carrying data-section="policy" (its own
    // capture for touched-section tracking); the outline row names it elsewhere.
    await waitFor(() => expect(document.querySelector('[data-section="policy"]')).toBeTruthy());

    // A classic brief has no policy at all — `sectionOrder("brief")` omits it.
    await user.click(screen.getByRole("button", { name: /Classic/ }));
    await waitFor(() => expect(document.querySelector('[data-section="policy"]')).toBeNull());
  });
});

describe("BriefPage — the refusal, in the one column (D3 / D38 / M1 / H2)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  // D37: adopting a brief IS arriving at its route — wait for the route's brief to land.
  const adopt = async (_user: ReturnType<typeof userEvent.setup>, id: string) => {
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(id),
    );
  };

  /**
   * A variation draft failing both Output and Variation Policy is the case that
   * exposes the bucket-order bounce (M1): `validateState`'s key order puts `policy`
   * before `output`, but `sectionOrder` reaches Output first — so the old first-key
   * bounce revealed Policy, a section the user reads last.
   */
  const brokenOutputAndPolicy = {
    file: "op.yaml",
    revision: "r1",
    brief: {
      ...brief("op"),
      mode: "variation",
      variation: {
        count: 0,
        axes: {
          layout: ["headline-top"],
          tone: ["bold"],
          background: { source: ["procedural"] },
          paletteShift: [0],
        },
      },
      output: { formats: [], platforms: [] },
    },
  };

  // Corrected for D35: Save carries the refusal now that "Apply to run" is retired.
  test("Save's refusal marks every failing section at once", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );

    // A blank draft fails Identity, Copy and Products — but nothing is marked yet
    // (D1): the user has been nowhere and has attempted nothing.
    expect(screen.queryByText(messages.briefId)).toBeNull();

    // D3: Save is never disabled — pressing it is how the user asks what is wrong.
    await saveVia(user, "Save");

    // Every failing section is marked, not only the first — and in one column the
    // user can see all of them without navigating anywhere. (The footer's status
    // sentence speaks the first error too, so the assertions are scoped to the
    // sections themselves.)
    await waitFor(() =>
      expect(
        within(document.getElementById("identity") as HTMLElement).getByText(messages.briefId),
      ).toBeTruthy(),
    );
    // The argument tracks the classic floor a previous lane moved (2 → 1) — it is
    // not exported by validate.ts, so the literal restates it. If the floor moves
    // again, this assertion moving with it is the point: it pins the wording.
    expect(
      within(document.getElementById("products") as HTMLElement).getByText(
        messages.products(1, "Classic"),
      ),
    ).toBeTruthy();
  });

  test("a refused Save reveals the first failing section in sectionOrder, not the first error bucket (M1)", async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    routes({ list: () => json({ briefs: [brokenOutputAndPolicy] }) });
    renderWithRun(<Editor id="op" />);
    await adopt(user, "op");

    await saveVia(user, "Save");

    // Output precedes Variation Policy in sectionOrder, which the bounce follows;
    // validateState's key order alone would have chosen Policy. The revealed
    // section is the one that takes focus (H2), so that is what names the choice.
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("output")));
    expect(document.activeElement).not.toBe(document.querySelector('[data-section="policy"]'));
  });

  test("a refused Save speaks its refusal, and exactly once (D38)", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );

    await saveVia(user, "Save");

    // One StatusLine speaking the refusal. There used to be two possible mounts of
    // the status surface (every guided step, and the foot of the Everything stack)
    // and the bar chose between them with a flag; there is one now, so "once" is
    // structural rather than a rule the flag had to keep.
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").filter((el) => el.textContent.startsWith("Not saved yet —")),
      ).toHaveLength(1),
    );
    // …and one ErrorStrip chip per failing section.
    const identityChips = Array.from(document.querySelectorAll("button.rounded-full")).filter((b) =>
      /Identity/.test(b.textContent ?? ""),
    );
    expect(identityChips).toHaveLength(1);
  });

  test("a refused Save leaves focus on the revealed section, never the body (H2)", async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    routes({ list: () => json({ briefs: [brokenOutputAndPolicy] }) });
    renderWithRun(<Editor id="op" />);
    await adopt(user, "op");

    await saveVia(user, "Save");

    // The refusal hands focus to the revealed section, the same target the
    // outline's activation uses — never `document.body`.
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("output")));
    expect(document.activeElement).not.toBe(document.body);
  });

  test("the action bar stands at the foot of the column, on arrival", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // One placement, unconditional: the verbs used to wait on the Review step in
    // Guided, so an editor could be on screen with no Save anywhere.
    expect(screen.getAllByTestId("action-bar")).toHaveLength(1);
  });
});

describe("BriefPage — the preview rail (R7)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  // D37: adopting a brief IS arriving at its route — wait for the route's brief to land.
  const adopt = async (_user: ReturnType<typeof userEvent.setup>, id: string) => {
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(id),
    );
  };

  const preview = () => screen.getByRole("complementary", { name: messages.previewLegend });
  // The rail describe's brief carries an output block, so the caption names a platform.
  const okEntry = {
    file: "ok.yaml",
    revision: "r1",
    brief: { ...brief("ok"), output: { formats: ["static"], platforms: ["linkedin"] } },
  };
  /**
   * `okEntry` carries no `treatments` (classic mode with none): `previewLook`
   * then answers `layout`/`tone` as `undefined` (pinned by
   * `preview-props.test.ts`'s "a classic draft with no treatment draws the
   * renderer's default"), and `PreviewFrame`'s own `cell` requires both — so
   * `okEntry` NEVER fetches a frame at all, in ANY of these tests, mutation
   * or not. The network-call proofs below need a brief whose look IS fully
   * specified, or "zero calls before" and "zero calls after" would agree
   * for a reason that has nothing to do with CC2's fix (a vacuous proof, the
   * same trap a green suite pinning a defect sets).
   */
  const fetchableEntry = {
    file: "fetch.yaml",
    revision: "r1",
    brief: {
      ...brief("fetch"),
      output: { formats: ["static"], platforms: ["linkedin"] },
      treatments: [{ id: "t1", layout: "headline-bottom" as const, tone: "bold" as const }],
    },
  };

  test("the rail mounts beside the column, found by its landmark (R7.3)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // getByRole — never getAllByRole(...)[0] (D48): the landmark is the one named slot.
    const rail = preview();
    // The dock's own words live inside the landmark: the caption names the platform
    // as a display label.
    expect(within(rail).getByText("Square · LinkedIn")).toBeTruthy();
    // D44: the rail is a sibling of the column, never inside it — the column is the
    // scroller and the rail is `sticky` against the shell's own scrollport.
    const column = document.getElementById("identity")?.closest("div.max-w-5xl") as HTMLElement;
    expect(column).toBeTruthy();
    expect(column.contains(rail)).toBe(false);
  });

  /** A mount count, not a visible-SVG count (R7/CC1): the container query hides
   *  the rail without unmounting it, so only a stable marker present in both
   *  the SVG-placeholder and real-frame branches (`PreviewFrame`'s wrapper,
   *  `data-testid="preview-frame"`) can tell "exactly one is MOUNTED" from
   *  "exactly one is VISIBLE". happy-dom applies no CSS at all, so it cannot
   *  distinguish the two by rendering either — a marker is the only honest way. */
  const mountedFrameCount = () => document.querySelectorAll('[data-testid="preview-frame"]').length;

  /**
   * D43's invariant, in the form SG1 leaves it in: EXACTLY ONE composed frame is
   * mounted in the whole editor, and it is the rail's.
   *
   * The gate this replaces (`presentation !== "guided" || step is not
   * review/layout`) existed because two other surfaces carried a frame of their
   * own — Review's figure and the Layout STEP's `preview`. Both are gone, so the
   * gate is gone; the count is what has to survive, and it is asserted by MOUNT
   * (the container query hides the rail without unmounting it, and happy-dom
   * applies no CSS at all, so a visible-node count would be the wrong question).
   *
   * The two ways to break it are both one prop away: pass `preview` to the
   * column's `LayoutSection`, or restore a Review surface. Either reads as
   * harmless — every other rendering assertion in this file stays green, because
   * a SECOND frame satisfies every query that looks for one.
   */
  test("exactly one composed frame is mounted in the editor, and it is the rail's (D43)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // Every section is on screen at once, Layout included — so this count is taken
    // over the whole editor, not over one step's worth of it.
    expect(document.getElementById("layout")).toBeTruthy();
    expect(mountedFrameCount()).toBe(1);
    const rail = preview();
    expect(rail.querySelectorAll('[data-testid="preview-frame"]').length).toBe(1);
  });

  test("the rail carries no step readout — there is no cursor to read (SG1)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // M2's "1 / 8" readout went with the walk. `previewStep` is deleted, so this
    // asserts the shape it had rather than the message: nothing in the rail reads
    // as a position in a walk.
    expect(within(preview()).queryByText(/ \/ /)).toBeNull();
  });

  test("a brief with nothing to draw shows the rail's empty state, not no rail (D142)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");
    expect(preview()).toBeTruthy();

    // The zero-product state is reached the way a user reaches it — removing every
    // product in the Products section. (A loaded file without products is seeded with
    // one placeholder, so a product-less brief fixture would never reach the null
    // branch.)
    await user.click(screen.getAllByRole("button", { name: messages.productRemove })[0]);
    await user.click(screen.getAllByRole("button", { name: messages.productRemove })[0]);

    // D142 — the pre-D142 behaviour this test used to pin was "no rail at
    // all"; now the landmark STAYS and names the missing PRODUCT ID, never
    // "add a product" (the Products section already shows a stub — the removal
    // above leaves exactly one, freshly blank) and never a fabricated
    // placeholder creative (D26).
    await waitFor(() => {
      const rail = screen.getByRole("complementary", { name: messages.previewLegend });
      expect(within(rail).getByText(messages.previewNeedsProductId)).toBeTruthy();
    });
    expect(mountedFrameCount()).toBe(0);
  });

  test("the two views are exclusive: the eye shows the preview, the code glyph shows the YAML (D61)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");
    const rail = preview();
    const eye = () => within(rail).getByRole("button", { name: messages.previewRailPreviewView });
    const code = () => within(rail).getByRole("button", { name: messages.previewRailYamlView });
    expect(eye().getAttribute("aria-pressed")).toBe("true");
    expect(code().getAttribute("aria-pressed")).toBe("false");

    await user.click(code());
    // One slot, one view: the YAML replaced the preview — never side by side.
    expect(within(rail).getByText(/targetRegion: /)).toBeTruthy();
    expect(within(rail).queryByText(/"targetRegion":/)).toBeNull();
    expect(within(rail).queryByText(messages.previewLegend)).toBeNull();
    expect(eye().getAttribute("aria-pressed")).toBe("false");
    expect(code().getAttribute("aria-pressed")).toBe("true");

    await user.click(eye());
    expect(within(rail).getByText(messages.previewLegend)).toBeTruthy();
    expect(within(rail).queryByText(/targetRegion: /)).toBeNull();
  });

  /**
   * CC1 mutation (c): a memo boundary that (wrongly) covered the YAML view
   * along with the preview would leave this reading the brief's ORIGINAL
   * `targetAudience`, not the edit — this is the assertion that catches it.
   */
  test("the YAML view is never memoised with the preview — a look-preserving edit still shows there", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // `targetAudience` is deliberately outside the preview's own memo key
    // (CC2: it changes nothing the compositor reads) — exactly the field a
    // wrongly-shared memo would fail to reflect.
    await user.type(screen.getByLabelText(messages.targetAudienceLabel), " plus more");

    const rail = preview();
    await user.click(within(rail).getByRole("button", { name: messages.previewRailYamlView }));
    expect(within(rail).getByText(/targetAudience: a plus more/)).toBeTruthy();
  });

  /** POST calls to the preview-frame route specifically — never conflated with
   *  the plan-debounce's own POST or any other traffic `routes()` records. */
  const previewFetchCalls = (calls: readonly { url: string; method: string }[]) =>
    calls.filter((c) => c.url.includes("/campaigns/preview-frame"));

  /** Comfortably past `PREVIEW_FRAME_DEBOUNCE_MS` (300 ms). */
  const outlastDebounce = () => new Promise((r) => setTimeout(r, 400));

  test("a look-preserving keystroke — typing in Target Audience — issues zero /preview-frame calls (CC2)", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [fetchableEntry] }) });
    renderWithRun(<Editor id="fetch" />);
    await adopt(user, "fetch");
    // Let the mount's own (legitimate) fetch settle first — the assertion
    // below is about the EDIT, never the initial paint. Asserted (not just
    // assumed): a brief whose look is unspecified (`okEntry`, elsewhere in
    // this file) never fetches at all, which would make "zero before, zero
    // after" agree for a reason that has nothing to do with the fix.
    await outlastDebounce();
    const before = previewFetchCalls(calls).length;
    expect(before).toBeGreaterThan(0);

    // `toBrief(state)` builds a new `brief` object on every keystroke
    // (object identity always changes), but `targetAudience` touches
    // nothing the compositor reads — the fetch key (CC2) must see through
    // that and issue NOTHING MORE, not merely "fewer" requests.
    await user.type(screen.getByLabelText(messages.targetAudienceLabel), " who hike on weekends");
    await outlastDebounce();

    expect(previewFetchCalls(calls).length).toBe(before);
  });

  test("zero /preview-frame calls while the YAML view is showing, even for an edit that would otherwise refetch", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [fetchableEntry] }) });
    renderWithRun(<Editor id="fetch" />);
    await adopt(user, "fetch");
    await outlastDebounce();
    expect(previewFetchCalls(calls).length).toBeGreaterThan(0); // the mount's own fetch actually happened

    await user.click(within(preview()).getByRole("button", { name: messages.previewRailYamlView }));
    const before = previewFetchCalls(calls).length;

    // The headline (`campaignMessage`) rides the compositor's `message` field
    // (`PreviewCreativeFrameUseCase.buildCompositeRequest`) — an edit that
    // WOULD refetch in the preview view (proved by the sibling test below,
    // which makes the same edit there). While the rail's mounted body is the
    // YAML `<pre>`, `PreviewDock` (and the `usePreviewFrame` inside it) is not
    // mounted at all, so nothing can fetch regardless of what changes.
    await user.type(screen.getByLabelText(messages.headlineLabel), "!");
    await outlastDebounce();

    expect(previewFetchCalls(calls).length).toBe(before);
  });

  test("editing the headline in the PREVIEW view does refetch — the sibling proof that the YAML test above is not vacuous", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [fetchableEntry] }) });
    renderWithRun(<Editor id="fetch" />);
    await adopt(user, "fetch");
    await outlastDebounce();
    const before = previewFetchCalls(calls).length;
    expect(before).toBeGreaterThan(0);

    await user.type(screen.getByLabelText(messages.headlineLabel), "!");
    await outlastDebounce();

    // The message rides the compositor's request (CC2's fetch key includes
    // it) — unlike targetAudience, this DOES fire another request.
    expect(previewFetchCalls(calls).length).toBeGreaterThan(before);
  });

  test("nothing fetches below the breakpoint, though the rail still mounts (CC2)", async () => {
    const originalInnerWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 500, configurable: true });
    try {
      const user = userEvent.setup();
      const calls = routes({ list: () => json({ briefs: [fetchableEntry] }) });
      renderWithRun(<Editor id="fetch" />);
      await adopt(user, "fetch");
      await outlastDebounce();

      // D43/D141's count invariant is about MOUNTING, not CSS visibility —
      // the rail (and its landmark) stays mounted below the breakpoint so a
      // resize back above it does not pay a fresh debounce. Only the fetch
      // stops: `useMinInlineSize` seeds `false` from this narrow
      // `window.innerWidth`, and the rail withholds `brief` from the dock.
      expect(preview()).toBeTruthy();
      expect(previewFetchCalls(calls).length).toBe(0);
    } finally {
      Object.defineProperty(window, "innerWidth", {
        value: originalInnerWidth,
        configurable: true,
      });
    }
  });

  test("the rail remembers its last view across a remount", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    const first = renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");
    await user.click(within(preview()).getByRole("button", { name: messages.previewRailYamlView }));
    expect(within(preview()).getByText(/targetRegion: /)).toBeTruthy();
    first.unmount();

    // A fresh editor reads the last choice before anything renders.
    renderWithRun(<Editor id="ok" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("ok"),
    );
    expect(within(preview()).getByText(/targetRegion: /)).toBeTruthy();
  });

  test("broken rail-view storage falls back to the preview view", async () => {
    const realGet = globalThis.localStorage.getItem.bind(globalThis.localStorage);
    const spy = vi.spyOn(globalThis.localStorage, "getItem").mockImplementation((key: string) => {
      if (key === "cf:preview-rail-view") throw new Error("storage gone");
      return realGet(key);
    });
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // A blocked store reads as the preview view, the same fallback as an absent key.
    expect(within(preview()).getByText(messages.previewLegend)).toBeTruthy();
    spy.mockRestore();
  });

  test("a rail choice that cannot reach storage does not break the switcher", async () => {
    const realSet = globalThis.localStorage.setItem.bind(globalThis.localStorage);
    const spy = vi
      .spyOn(globalThis.localStorage, "setItem")
      .mockImplementation((key: string, value: string) => {
        if (key === "cf:preview-rail-view") throw new Error("storage gone");
        return realSet(key, value);
      });
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    await user.click(within(preview()).getByRole("button", { name: messages.previewRailYamlView }));
    expect(within(preview()).getByText(/targetRegion: /)).toBeTruthy();
    spy.mockRestore();
  });

  test("the rail pins inside the shell's scrollport and never leaves the page (D44)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    const { container } = renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    const rail = preview();
    const root = container.firstElementChild as HTMLElement;
    expect(root.contains(rail)).toBe(true);
    // Pinning the D44 decision the way the action bar's test pins its own: happy-dom
    // performs no layout, but `sticky` against the shell's scroller is the decision,
    // and `fixed` — the viewport pin that covers the sidebar — is the regression.
    expect(rail.className).toMatch(/\bsticky\b/);
    expect(rail.className).not.toMatch(/\bfixed\b/);
    // §6 question 1, wiring half: the rail reads the editor ROW's width, not the
    // viewport's, and the row is the query container. The compile test in
    // tailwind-alpha.test.ts proves the variant emits a real @container rule; the
    // browser matrix in the R7 plan §4 records the layout half the suite cannot.
    expect(root.querySelector('[class*="container-type"]')).not.toBeNull();
    expect(rail.className).toContain("[@container(min-width:56rem)]:flex");
  });

  /**
   * CC2's own gap, closed on review: the CSS breakpoint (this class) and its
   * JS mirror (`PREVIEW_RAIL_MIN_INLINE_PX`, `use-min-inline-size.ts`) were
   * asserted independently — this test and the hook's own unit test each
   * checked their own side, so changing 56rem to 64rem, or 896 to 1024,
   * left every test green while the rail's visibility and its fetch gate
   * quietly disagreed. This DERIVES one from the other instead of
   * restating both, so either drifting alone fails exactly this test.
   */
  test("the CSS breakpoint and its JS mirror cannot drift apart silently", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    const rail = preview();
    const match = rail.className.match(/@container\(min-width:(\d+)rem\)/);
    expect(match).not.toBeNull();
    const rem = Number(match![1]);
    // 16px root — the same assumption `PREVIEW_RAIL_MIN_INLINE_PX`'s own
    // comment names, so this multiplication is not a second, independent
    // guess at the root size.
    expect(rem * 16).toBe(PREVIEW_RAIL_MIN_INLINE_PX);
  });
});

describe("BriefPage — the Layout section (T7)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  // D37: adopting a brief IS arriving at its route — wait for the route's brief to land.
  const adopt = async (_user: ReturnType<typeof userEvent.setup>, id: string) => {
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(id),
    );
  };

  const okEntry = {
    file: "ok.yaml",
    revision: "r1",
    brief: { ...brief("ok"), output: { formats: ["static"], platforms: ["linkedin"] } },
  };
  const randEntry = {
    file: "rand.yaml",
    revision: "r1",
    brief: {
      ...brief("rand"),
      mode: "variation" as const,
      variation: {
        count: 8,
        axes: {
          layout: ["headline-top"],
          tone: ["bold"],
          background: { source: ["procedural"] },
          paletteShift: [0],
        },
      },
    },
  };

  /**
   * T7's ordering claim, made against the column's DOM rather than against a
   * walk. The two tests this replaces drove Next/Back between the Template,
   * Layout and Output STEPS; the sections are all mounted now, so the order is
   * the document order — and `sectionOrder` is still the one list that decides
   * it, in both modes.
   */
  const renderedOrder = () => {
    const ids = sectionOrder("brief").concat(sectionOrder("variation"));
    return Array.from(document.querySelectorAll<HTMLElement>("section[id]"))
      .map((el) => el.id)
      .filter((id) => ids.includes(id as (typeof ids)[number]));
  };

  test("the classic column carries Layout between Template and Output (T7)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    const order = renderedOrder();
    expect(order.indexOf("layout")).toBe(order.indexOf("template") + 1);
    expect(order.indexOf("output")).toBe(order.indexOf("layout") + 1);
  });

  test("randomized places Layout between Template and Output too (T7)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [randEntry] }) });
    renderWithRun(<Editor id="rand" />);
    await adopt(user, "rand");

    const order = renderedOrder();
    expect(order.indexOf("layout")).toBe(order.indexOf("template") + 1);
    expect(order.indexOf("output")).toBe(order.indexOf("layout") + 1);
  });

  test("the Sections outline reaches the Layout section (D25/GB-D18)", async () => {
    const user = userEvent.setup();
    const scroller = vi.fn();
    Element.prototype.scrollIntoView = scroller;
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    const row = await screen.findByRole("button", { name: "Layout" });
    await user.click(row);
    // The outline's activation scrolls AND hands focus (W4.2) — the section is
    // already mounted, so both happen in the same commit.
    const section = document.getElementById("layout") as HTMLElement;
    expect(scroller.mock.instances).toContain(section);
    expect(document.activeElement).toBe(section);
  });

  test("a style choice made in the Layout section reaches the brief the save would send (D58)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    await user.click(screen.getByRole("button", { name: "Lora" }));

    // The projection is on screen in the rail's YAML view, which the rail now
    // serves unconditionally (SG1 removed the per-step suppression).
    const rail = screen.getByRole("complementary", { name: messages.previewLegend });
    await user.click(within(rail).getByRole("button", { name: messages.previewRailYamlView }));
    expect(within(rail).getByText(/fontFamily: Lora/)).toBeTruthy();
  });
});

describe("BriefPage — Generate's three-way question (D35)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  /**
   * The real editor and the real header, mounted together — the D35 question is a
   * contract between the two, so neither a mock handoff nor a mock editor can prove
   * it. While the editor's on-screen draft differs from the shell's brief, Generate
   * must ask; while it does not, Generate must behave exactly as it always has.
   */
  const EditorAndHeader = ({ id = "camp" }: { id?: string }) => (
    <>
      <Header />
      <Editor id={id} />
    </>
  );

  test("Generate from a dirty editor asks the three-way, one prompt, and 'Run this draft' never runs the previous campaign", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<EditorAndHeader />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    // Edit the loaded brief: the shell still holds camp, the screen holds camp+edit.
    await user.type(screen.getByLabelText("Headline"), " edited");

    await user.click(screen.getByRole("button", { name: "Generate" }));
    const dialog = await screen.findByRole("dialog", { name: messages.generateDraftTitle });
    // Exactly one prompt on this path: the guard's "Unsaved edits" is nowhere.
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();

    await user.click(
      within(dialog).getByRole("button", { name: new RegExp(`^${messages.generateDraftRunThis}`) }),
    );

    // The ON-SCREEN draft was POSTed — never the shell's previous campaign.
    const generatePost = await waitFor(() => {
      const call = calls.find((c) => c.url.includes("/campaigns/generate"));
      expect(call).toBeTruthy();
      return call!;
    });
    expect((generatePost.body as { campaignMessage?: string }).campaignMessage).toBe("Hi edited");
    // run-without-write: no brief write left the page
    expect(calls.filter((c) => c.method !== "GET" && c.url.includes("/campaigns/briefs"))).toEqual(
      [],
    );
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
  });

  test("a reload at /brief/new applies no brief — Generate must not run the last one", async () => {
    // D37 keeps `cf:brief` as a *last-opened* record so the bare /brief route can hand
    // the visitor back. It is a pointer, not an application: arriving at the blank
    // route released the campaign. The provider restores that record on mount, and
    // provider effects run AFTER their children's — so the release must still win, or
    // Generate here would spend image-generation credits on the previous brief.
    const user = userEvent.setup();
    localStorage.setItem("cf:brief", JSON.stringify(brief("camp")));
    const calls = routes({});
    renderWithRun(
      <>
        <Header />
        <NewEditor />
      </>,
    );
    await waitFor(() => expect(screen.getByLabelText("Campaign Name")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "Generate" }));

    expect(screen.getByText(messages.generateNoBrief)).toBeTruthy();
    expect(calls.filter((c) => c.url.includes("/campaigns/generate"))).toEqual([]);
  });

  test("'Save and run' writes, then runs what was written", async () => {
    const user = userEvent.setup();
    const calls = routes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      // the real PUT stores and returns the parsed body it was sent
      put: (_url, body) => json({ file: "camp.yaml", brief: body, revision: "r2" }),
    });
    renderWithRun(<EditorAndHeader />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await user.type(screen.getByLabelText("Headline"), " edited");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    const dialog = await screen.findByRole("dialog", { name: messages.generateDraftTitle });
    await user.click(
      within(dialog).getByRole("button", { name: new RegExp(`^${messages.generateDraftSaveRun}`) }),
    );

    // The write went through the editor's own save path (conditional PUT with the
    // load-time revision), and the run carried the brief as the server stored it.
    const generatePost = await waitFor(() => {
      const call = calls.find((c) => c.url.includes("/campaigns/generate"));
      expect(call).toBeTruthy();
      return call!;
    });
    expect((generatePost.body as { campaignMessage?: string }).campaignMessage).toBe("Hi edited");
    const put = calls.find((c) => c.method === "PUT");
    expect(put?.url).toContain("revision=r1");
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
  });

  test("'Run this draft' on an invalid draft refuses: no run charged, the section named, the editor reveals it", async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<EditorAndHeader />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    // Differ AND be invalid: edit the headline, then clear it — Copy blocks an empty
    // headline, and the draft still differs from the shell's committed brief.
    // (Campaign Name is readOnly on a loaded brief, so the headline is the field
    // that can carry the invalidity here.)
    await user.type(screen.getByLabelText("Headline"), " edited");
    await user.clear(screen.getByLabelText("Headline"));

    await user.click(screen.getByRole("button", { name: "Generate" }));
    const dialog = await screen.findByRole("dialog", { name: messages.generateDraftTitle });
    await user.click(
      within(dialog).getByRole("button", { name: new RegExp(`^${messages.generateDraftRunThis}`) }),
    );

    // The money: pressing with a half-filled brief must never start the pipeline —
    // the server would refuse it and the user would be charged anyway.
    expect(calls.filter((c) => c.url.includes("/campaigns/generate"))).toEqual([]);
    expect(nextMock().router.push).not.toHaveBeenCalled();

    // The refusal names the first blocking section (GB-D3: the press answers — the
    // verb is never disabled)…
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("status")
          .some((el) => el.textContent === messages.generateDraftBlocked(SECTION_TITLES.copy)),
      ).toBe(true),
    );
    // …the editor's own refusal spoke too (attempted → the status sentence refuses)…
    expect(
      screen.getAllByRole("status").some((el) => el.textContent.startsWith("Not saved yet —")),
    ).toBe(true);
    // …and the reveal is real: the user is sent to the blocking section, with focus
    // on it — the same landing Save's refusal gives (H2).
    expect(document.activeElement).toBe(document.getElementById("copy"));
  });

  test("'Save and run' on an invalid draft inherits the refusal through the save path", async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<EditorAndHeader />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await user.type(screen.getByLabelText("Headline"), " edited");
    await user.clear(screen.getByLabelText("Headline"));

    await user.click(screen.getByRole("button", { name: "Generate" }));
    const dialog = await screen.findByRole("dialog", { name: messages.generateDraftTitle });
    await user.click(
      within(dialog).getByRole("button", { name: new RegExp(`^${messages.generateDraftSaveRun}`) }),
    );

    // The save path's own `refuseInvalid` gates it — nothing is written, nothing
    // runs, and the editor has already bounced to Copy with the refusal on screen;
    // the header carries no gate of its own to disagree with.
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").some((el) => el.textContent.startsWith("Not saved yet —")),
      ).toBe(true),
    );
    expect(writes(calls)).toEqual([]);
    expect(calls.filter((c) => c.url.includes("/campaigns/generate"))).toEqual([]);
    expect(document.activeElement).toBe(document.getElementById("copy"));
  });

  test("Generate from a clean editor runs the committed brief without asking", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<EditorAndHeader />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    // No edits: the draft matches the shell brief, so there is no question to ask.
    await user.click(screen.getByRole("button", { name: "Generate" }));

    expect(screen.queryByRole("dialog", { name: messages.generateDraftTitle })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
    const generatePost = await waitFor(() => {
      const call = calls.find((c) => c.url.includes("/campaigns/generate"));
      expect(call).toBeTruthy();
      return call!;
    });
    expect((generatePost.body as { id?: string }).id).toBe("camp");
  });
});

describe("the route is the source of truth (D37)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  test("/brief/{id} loads that brief, and the shell follows what the URL named", async () => {
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(
      <>
        <RunBriefProbe />
        <Editor id="camp" />
      </>,
    );

    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );
    // setRunBrief follows AFTER the load succeeds, so Generate runs what the URL shows
    await waitFor(() => expect(screen.getByTestId("run-brief").textContent).toBe("camp"));
  });

  test("a reload at the same route reopens the same brief — without cf:brief to lean on", async () => {
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });

    const first = renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );
    first.unmount();

    // The reload: no shell state to inherit (the record is dropped, not just absent),
    // only the route.
    localStorage.removeItem("cf:brief");
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );
  });

  test("an unknown id is answered with the empty state, names it, and creates no draft", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(
      <>
        <RunBriefProbe />
        <Editor id="ghost" />
      </>,
    );

    // M3: nothing is published into the sidebar either — this page is not an editor.
    expect(await screen.findByText(messages.briefNotFound("ghost"))).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Classic")).toBeNull());
    expect(
      screen.getByRole("link", { name: messages.briefNotFoundGrid }).getAttribute("href"),
    ).toBe("/grid");
    expect(screen.getByRole("link", { name: messages.briefNotFoundNew }).getAttribute("href")).toBe(
      "/brief/new",
    );
    // No draft was created for the unknown id.
    await new Promise((r) => setTimeout(r, 50));
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
    expect(keys.filter((k) => k.startsWith("cf:draft:"))).toEqual([]);

    // W1 (D66/D67): the way out is the create dialog — the link keeps its href, but
    // the gesture opens the door; the editor is not mounted, so the guard is silent.
    await user.click(screen.getByRole("link", { name: messages.briefNotFoundNew }));
    expect(await screen.findByRole("dialog", { name: messages.createCampaignTitle })).toBeTruthy();
    expect(nextMock().router.push).not.toHaveBeenCalled();
  });

  test.each(["metaKey", "ctrlKey", "shiftKey", "altKey", "button"] as const)(
    "a %s click on the unknown-id new-brief link is left to the browser",
    async (modifier) => {
      routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
      renderWithRun(<Editor id="ghost" />);
      expect(await screen.findByText(messages.briefNotFound("ghost"))).toBeTruthy();
      const link = screen.getByRole("link", { name: messages.briefNotFoundNew });
      const allowed = fireEvent.click(link, {
        [modifier]: modifier === "button" ? 1 : true,
      });
      // fireEvent returns false when preventDefault ran — a modified click must not.
      expect(allowed).toBe(true);
      expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull();
    },
  );

  test("a malformed id is refused by the same rule the Save-as backstop enforces", async () => {
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="Not Safe" />);

    // SAFE_ID_PATTERN refuses it before any match attempt: the same shape of input
    // that once reached the API as a bare 400 never leaves the route.
    expect(await screen.findByText(messages.briefNotFound("Not Safe"))).toBeTruthy();
  });

  test("the /brief/new draft survives a reload, under one stable key (H6)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });

    const first = renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""),
    );
    await fillValidDraft(user, "typed");
    await waitFor(() => expect(localStorage.getItem("cf:draft:new")).not.toBeNull());
    first.unmount();

    // The reload lands on the same route and finds the draft it left.
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("typed"),
    );
  });
});

describe("the create seed (W1)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  const fillDialog = async (
    user: ReturnType<typeof userEvent.setup>,
    root: { getByLabelText: typeof screen.getByLabelText; getByRole: typeof screen.getByRole },
  ) => {
    await user.type(root.getByLabelText(messages.campaignNameLabel), "Summer Spark");
    await user.click(root.getByRole("button", { name: messages.createCampaignConfirm }));
  };

  test("the guard asks exactly once for a dirty editor, before the dialog opens, and Create applies the seed in place", async () => {
    nextMock().nav.pathname = "/brief/new";
    // Everything presentation: every section stays mounted, so the applied values
    // are assertable directly — the landing claim has its own tests below.
    const user = userEvent.setup();
    routes({});
    renderWithRun(
      <>
        <BrowseBriefsButton />
        <NewEditor />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "",
      ),
    );
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "typed");

    // The sidebar's gesture: the guard asks first (D67)…
    await user.click(screen.getByRole("button", { name: /Create new/ }));
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    // …and the create dialog is not open yet.
    expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull();
    await user.click(within(prompt).getByRole("button", { name: "Leave" }));

    await fillDialog(
      user,
      within(await screen.findByRole("dialog", { name: messages.createCampaignTitle })),
    );

    // F8: the same-URL push resets nothing, so the seed was applied in place —
    // and never through requestReplace (D67): one question for the whole gesture.
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "Summer Spark",
      ),
    );
    // D97 — the seed answers name and mode only: region and audience stay blank,
    // waiting for the Identity step this landing is now on (D98).
    expect((screen.getByLabelText("Target Region") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(messages.targetAudienceLabel) as HTMLInputElement).value).toBe(
      "",
    );
    expect(screen.queryByRole("dialog", { name: messages.createCampaignTitle })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(screen.queryAllByRole("dialog", { name: "Unsaved edits" })).toHaveLength(0);
  });

  test("an in-place seed lands on Identity with the name applied (D98)", async () => {
    nextMock().nav.pathname = "/brief/new";
    const user = userEvent.setup();
    routes({});
    renderWithRun(
      <>
        <BrowseBriefsButton />
        <NewEditor />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "",
      ),
    );
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "typed");

    await user.click(screen.getByRole("button", { name: /Create new/ }));
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(prompt).getByRole("button", { name: "Leave" }));
    await fillDialog(
      user,
      within(await screen.findByRole("dialog", { name: messages.createCampaignTitle })),
    );

    // D98 — "lands on Identity" is true by construction since SG1: Identity is
    // the first section of the one column, so there is no cursor to place and no
    // way to arrive one step past two empty required fields. What is left to
    // assert is that the seed APPLIED and spent its key.
    await waitFor(() => expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull());
    expect(document.getElementById("identity")).toBeTruthy();
    // The seed rode a patch action, so the slug was derived in the reducer (F18) —
    // the Identity readout shows it; the dialog never did.
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
      "Summer Spark",
    );
    expect(screen.getByText("summer-spark")).toBeTruthy();
  });

  test("after an in-place seed, no step baton remains (the leftover-baton pin)", async () => {
    nextMock().nav.pathname = "/brief/new";
    const user = userEvent.setup();
    routes({});
    renderWithRun(
      <>
        <BrowseBriefsButton />
        <NewEditor />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "",
      ),
    );
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "typed");

    await user.click(screen.getByRole("button", { name: /Create new/ }));
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(prompt).getByRole("button", { name: "Leave" }));
    await fillDialog(
      user,
      within(await screen.findByRole("dialog", { name: messages.createCampaignTitle })),
    );

    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "Summer Spark",
      ),
    );
    // `takeSeed` spends the companion baton as well as the seed. SG1 removed the
    // baton's only APPLIER (the step cursor), so a leftover can no longer move
    // anything — but it is still written on the cross-route create path, and a key
    // that is written and never cleared is a leak this pin catches.
    expect(localStorage.getItem("cf:step-handoff")).toBeNull();
  });

  test("after a refused Save, an in-place seed arrives with nothing red — attempted is reset", async () => {
    nextMock().nav.pathname = "/brief/new";
    const user = userEvent.setup();
    routes({});
    renderWithRun(
      <>
        <BrowseBriefsButton />
        <NewEditor />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "",
      ),
    );
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "typed");
    // A refused Save sets attempted: every error shows and the status refuses.
    // (It was a refused Next before SG1 — the wizard's own gesture; Save is the
    // verb that carries the refusal now, and it is the same `attempted` flag.)
    await saveVia(user, "Save");
    expect(await screen.findByText(/Not saved yet/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Create new/ }));
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(prompt).getByRole("button", { name: "Leave" }));
    await fillDialog(
      user,
      within(await screen.findByRole("dialog", { name: messages.createCampaignTitle })),
    );

    // The arrival is not red: the seed reset attempted/touched (L1.1).
    await waitFor(() => expect(screen.queryByText(/Not saved yet/)).toBeNull());
    expect(screen.getByText(/New brief — fill/)).toBeTruthy();
  });

  test("a seed created elsewhere is applied on mount, and both batons are spent", async () => {
    routes({});
    // What the dialog's Create does from another route (verified in its own suite):
    // publish the seed, stash the landing step, then push.
    await act(async () => {
      await createCampaign({ name: "Summer Spark", type: "social-post" });
    });
    localStorage.setItem("cf:step-handoff", "identity");

    nextMock().nav.pathname = "/brief/new";
    renderWithRun(<NewEditor />);
    // The APPLIED field, never only the spent key: the landing itself stopped
    // being a claim when SG1 deleted the cursor, so the seed's effect on the
    // draft is the whole assertion.
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "Summer Spark",
      ),
    );
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    expect(localStorage.getItem("cf:step-handoff")).toBeNull();
  });

  test("a paid-social seed sets the editor's mode and the Randomized section list", async () => {
    routes({});
    // The T2 dialog bridge maps the mode panel's Randomized choice to the
    // paid-social type (D108); T3 replaces the panel with the type field.
    await act(async () => {
      await createCampaign({ name: "Summer Spark", type: "paid-social" });
    });

    nextMock().nav.pathname = "/brief/new";
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "Summer Spark",
      ),
    );
    expect(screen.getByRole("button", { name: "variation" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "brief" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(screen.getByRole("button", { name: "Variation Policy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Treatments" })).toBeNull();
  });

  test("an old-shape seed from the previous build is discarded, not half-applied (F5)", async () => {
    routes({});
    // What the currently deployed build writes: the four-field seed. Accepting it
    // would seed a brief with a name and nothing else, silently — the guard
    // discards it wholesale and the user starts clean.
    localStorage.setItem(
      CREATE_SEED_KEY,
      JSON.stringify({
        name: "Summer Spark",
        targetRegion: "EU",
        targetAudience: "trail runners",
        mode: "brief",
      }),
    );
    nextMock().nav.pathname = "/brief/new";
    renderWithRun(<NewEditor />);
    await waitFor(() => expect(screen.getByLabelText(messages.campaignNameLabel)).toBeTruthy());
    // No partial patch: even the name is not seeded — the seed was discarded whole.
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(messages.targetRegionLabel) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(messages.targetAudienceLabel) as HTMLInputElement).value).toBe(
      "",
    );
    // Spent, not retried: a refused baton cannot poison the next mount either.
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
  });

  test("a rejected legacy seed also spends its landing baton, so the editor lands on Identity (D98)", async () => {
    routes({});
    // Both keys the previously deployed build left after an interrupted create —
    // the old four-field seed and the Copy baton that skipped Identity. takeSeed
    // in isolation and the navigation hook in isolation each look fine; the bug
    // is the interaction: a refused seed that does not spend the companion baton
    // lets the mount effect apply "copy" and land a blank brief one step past
    // two empty required fields.
    localStorage.setItem(
      "cf:create-seed",
      JSON.stringify({
        name: "Summer Spark",
        targetRegion: "EU",
        targetAudience: "trail runners",
        mode: "brief",
      }),
    );
    localStorage.setItem("cf:step-handoff", "copy");
    nextMock().nav.pathname = "/brief/new";
    renderWithRun(<NewEditor />);

    // SG1 — the "lands on Identity" half of this test is retired with the cursor:
    // a leftover baton has nothing to move. What remains, and is the defect the
    // test was written for, is that the refused seed SPENDS the companion baton
    // rather than leaving it behind.
    await waitFor(() => expect(localStorage.getItem("cf:step-handoff")).toBeNull());

    // Discard: no name, region or audience seeded.
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(messages.targetRegionLabel) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(messages.targetAudienceLabel) as HTMLInputElement).value).toBe(
      "",
    );
  });

  test("the #217 {name, mode} seed is discarded, not half-applied, and spends its baton (D108)", async () => {
    routes({});
    // What the previously deployed build wrote: the two-field seed. It is
    // refused whole — no name seeded, the mode stays Classic — and the
    // companion baton is spent rather than left behind.
    localStorage.setItem(
      CREATE_SEED_KEY,
      JSON.stringify({ name: "Summer Spark", mode: "variation" }),
    );
    localStorage.setItem("cf:step-handoff", "copy");
    nextMock().nav.pathname = "/brief/new";
    renderWithRun(<NewEditor />);
    await waitFor(() => expect(screen.getByLabelText(messages.campaignNameLabel)).toBeTruthy());
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: "brief" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "variation" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    // Both keys cleared: a refused baton cannot poison the next mount either.
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    expect(localStorage.getItem("cf:step-handoff")).toBeNull();
  });

  test("a paid-social seed is applied once — a platform toggled off stays off (D109)", async () => {
    routes({});
    localStorage.setItem(
      CREATE_SEED_KEY,
      JSON.stringify({ name: "Summer Spark", type: "paid-social" }),
    );
    nextMock().nav.pathname = "/brief/new";
    const user = userEvent.setup();
    const view = renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "Summer Spark",
      ),
    );
    // The preset arrived: the paid platforms are on, mode is Randomized.
    expect(
      screen.getByRole("button", { name: "instagram-story" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "brief" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    // The user's change: one platform off.
    await user.click(screen.getByRole("button", { name: "tiktok" }));
    expect(screen.getByRole("button", { name: "tiktok" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    // The remount this used to force with a presentation switch is gone with the
    // toggle — and the full remount below is the stronger form of the same
    // question anyway (the reload case), so nothing it proved is lost.
    // A full remount does not re-apply the preset: the seed was spent by
    // its one read, so the user's toggled-off platform survives the return.
    view.unmount();
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "Summer Spark",
      ),
    );
    expect(screen.getByRole("button", { name: "tiktok" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    // Nothing is left to re-apply.
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    expect(takeSeed()).toBeNull();
  });

  test("a malformed seed leaves a working blank editor rather than throwing", async () => {
    routes({});
    // Syntactically valid, structurally not a seed — takeSeed must spend it as null.
    localStorage.setItem(CREATE_SEED_KEY, JSON.stringify({ name: 42 }));
    nextMock().nav.pathname = "/brief/new";
    renderWithRun(<NewEditor />);
    await waitFor(() => expect(screen.getByLabelText(messages.campaignNameLabel)).toBeTruthy());
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe("");
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "spark");
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
      "spark",
    );
  });

  test("a seed published while a named brief is open is not applied in place", async () => {
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "camp",
      ),
    );

    await act(async () => {
      await createCampaign({ name: "Other", type: "paid-social" });
    });
    // The gate is the route: the named brief stays on screen, and the seed waits in
    // the store for a blank-route mount to spend it.
    expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
      "camp",
    );
    expect(localStorage.getItem(CREATE_SEED_KEY)).not.toBeNull();
  });
});

describe("the abandoned-draft two-way (W3 / F19)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  const fillDialog = async (
    user: ReturnType<typeof userEvent.setup>,
    root: { getByLabelText: typeof screen.getByLabelText; getByRole: typeof screen.getByRole },
  ) => {
    await user.type(root.getByLabelText(messages.campaignNameLabel), "Summer Spark");
    await user.click(root.getByRole("button", { name: messages.createCampaignConfirm }));
  };

  test("a dirty editor on a named route still asks about the abandoned blank draft (F19)", async () => {
    // The stale blank draft from an earlier session, invisible from this route —
    // the exact state a bare `isDirty` check would silently overwrite.
    saveDraftToStorage({ ...initialEditorState(), campaignName: "Abandoned" });
    nextMock().nav.pathname = "/brief/camp-1";
    routes({ list: () => json({ briefs: [entry("camp-1", "r1")] }) });
    const user = userEvent.setup();
    renderWithRun(
      <>
        <BrowseBriefsButton />
        <Editor id="camp-1" />
      </>,
    );
    await waitForEditorReady();
    // The name is the slug's echo here and locked (C23); the audience edit is what
    // makes this editor dirty — about camp-1, never about the blank draft.
    await user.type(screen.getByLabelText(messages.targetAudienceLabel), "more");

    // The guard asks first, about camp-1's draft (D67)…
    await user.click(screen.getByRole("button", { name: /Create new/ }));
    const guard = await screen.findByRole("dialog", { name: messages.confirmDialogTitle });
    await user.click(within(guard).getByRole("button", { name: messages.confirmDialogLeave }));

    // …but the guard's dirty flag is about camp-1, not the blank draft, so the
    // dialog's own two-way asks where the guard could not.
    await fillDialog(
      user,
      within(await screen.findByRole("dialog", { name: messages.createCampaignTitle })),
    );
    const prompt = await screen.findByRole("dialog", { name: messages.resumeDraftTitle });
    // Start over proceeds exactly as the unguarded create.
    await user.click(within(prompt).getByRole("button", { name: messages.resumeDraftStartOver }));
    await waitFor(() => expect(localStorage.getItem(CREATE_SEED_KEY)).not.toBeNull());
    // One gesture, one answer: the publication must not re-ask.
    expect(screen.queryAllByRole("dialog", { name: messages.resumeDraftTitle })).toHaveLength(0);
  });

  test("a dirty editor on the blank route raises the guard once and never the two-way (D67)", async () => {
    nextMock().nav.pathname = "/brief/new";
    const user = userEvent.setup();
    routes({});
    renderWithRun(
      <>
        <BrowseBriefsButton />
        <NewEditor />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "",
      ),
    );
    await user.type(screen.getByLabelText(messages.campaignNameLabel), "typed");
    // The autosave effect wrote the very draft the seed would overwrite.
    await waitFor(() => expect(localStorage.getItem("cf:draft:new")).not.toBeNull());

    await user.click(screen.getByRole("button", { name: /Create new/ }));
    const prompt = await screen.findByRole("dialog", { name: messages.confirmDialogTitle });
    await user.click(within(prompt).getByRole("button", { name: messages.confirmDialogLeave }));
    await fillDialog(
      user,
      within(await screen.findByRole("dialog", { name: messages.createCampaignTitle })),
    );

    // One question for the whole gesture (D67): the seed applies in place, and
    // the two-way about the very draft the guard just discussed never opens.
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "Summer Spark",
      ),
    );
    expect(screen.queryAllByRole("dialog", { name: messages.resumeDraftTitle })).toHaveLength(0);
    expect(localStorage.getItem(CREATE_SEED_KEY)).toBeNull();
  });

  test("a pristine editor with no stored draft raises neither the guard nor the two-way", async () => {
    nextMock().nav.pathname = "/brief/new";
    const user = userEvent.setup();
    routes({});
    renderWithRun(
      <>
        <BrowseBriefsButton />
        <NewEditor />
      </>,
    );
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "",
      ),
    );

    // A pristine editor has nothing to lose, so the guard does not ask…
    await user.click(screen.getByRole("button", { name: /Create new/ }));
    const dialog = await screen.findByRole("dialog", { name: messages.createCampaignTitle });
    expect(screen.queryByRole("dialog", { name: messages.confirmDialogTitle })).toBeNull();
    // …and with no stored draft there is nothing to recover, so neither does the
    // dialog: the create proceeds exactly as it did before W3.
    await fillDialog(user, within(dialog));
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "Summer Spark",
      ),
    );
    expect(screen.queryAllByRole("dialog", { name: messages.resumeDraftTitle })).toHaveLength(0);
  });
});

describe("a failed listing is its own state (D83 / F-A)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  test("a rejected listBriefs on a named route renders the failure state, not the not-found state", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    routes({ list: () => json({ error: "boom" }, 500) });
    renderWithRun(
      <>
        <RunBriefProbe />
        <Editor id="camp" />
      </>,
    );

    // The failure is recorded as well as logged — the log alone was the defect.
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Failed to load briefs:", expect.anything()),
    );
    expect(await screen.findByText(messages.briefListFailed("camp"))).toBeTruthy();
    // D83: a failed read never becomes a statement that the campaign does not exist…
    expect(screen.queryByText(messages.briefNotFound("camp"))).toBeNull();
    // …and the remedy that invites a duplicate is exactly what it must not offer.
    expect(screen.queryByText(messages.briefNotFoundNew)).toBeNull();
    expect(screen.getByRole("button", { name: messages.briefListFailedRetry })).toBeTruthy();
    // No draft was created for the id the listing could not answer about.
    await new Promise((r) => setTimeout(r, 50));
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
    expect(keys.filter((k) => k.startsWith("cf:draft:"))).toEqual([]);
    error.mockRestore();
  });

  test("an empty-but-successful listing on a named route still renders the not-found state", async () => {
    routes({ list: () => json({ briefs: [] }) });
    renderWithRun(<Editor id="camp" />);

    // A listing that succeeded and lacks the id is the one truthful not-found.
    expect(await screen.findByText(messages.briefNotFound("camp"))).toBeTruthy();
    expect(screen.queryByText(messages.briefListFailed("camp"))).toBeNull();
  });

  test("/brief/new with a rejected listing still renders the blank editor", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    routes({ list: () => json({ error: "boom" }, 500) });
    renderWithRun(<NewEditor />);

    // Wait for the listing to have actually FAILED before asserting anything about the
    // editor. Campaign Name is "" on first paint and /brief/new never awaits the listing,
    // so asserting first would pass before the 500 settled — green even with the render
    // scope dropped. The failure must be on the record, and the blank editor must have
    // survived it.
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Failed to load briefs:", expect.anything()),
    );
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: messages.briefListFailedRetry })).toBeNull();
    error.mockRestore();
  });

  test("a listing refresh that fails after a successful save leaves the loaded editor on screen", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    let listFails = false;
    const calls = routes({
      list: () =>
        listFails ? json({ error: "boom" }, 500) : json({ briefs: [entry("camp", "r1")] }),
      // handleSave refreshes the listing after the write; that refresh is the one that fails.
      put: () => {
        listFails = true;
        return json({ file: "camp.yaml", brief: brief("camp"), revision: "r2" });
      },
    });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    await saveVia(user, "Save");
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Failed to load briefs:", expect.anything()),
    );

    // A failed refresh on a loaded editor changes nothing on screen…
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp");
    expect(screen.queryByText(messages.briefListFailed("camp"))).toBeNull();
    expect(screen.queryByRole("button", { name: messages.briefListFailedRetry })).toBeNull();
    error.mockRestore();
  });

  test("the failure state publishes no sidebar panels", async () => {
    routes({ list: () => json({ error: "boom" }, 500) });
    renderWithRun(<Editor id="camp" />);

    // M3, extended: a page that is not an editor publishes nothing into the sidebar.
    expect(await screen.findByText(messages.briefListFailed("camp"))).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Classic")).toBeNull());
  });

  test("the in-page retry re-runs the listing and renders the brief — no focus event", async () => {
    const user = userEvent.setup();
    let fail = true;
    routes({
      list: () => (fail ? json({ error: "boom" }, 500) : json({ briefs: [entry("camp", "r1")] })),
    });
    renderWithRun(<Editor id="camp" />);
    expect(await screen.findByText(messages.briefListFailed("camp"))).toBeTruthy();

    // The user is sitting on the page: window focus never fires for them, so the
    // retry affordance is the recovery path. Clicking it is all it takes.
    fail = false;
    await user.click(screen.getByRole("button", { name: messages.briefListFailedRetry }));
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );
    expect(screen.queryByText(messages.briefListFailed("camp"))).toBeNull();
  });

  test("a stale success does not clear the failure recorded by a newer listing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending: Array<(r: Response) => void> = [];
    routes({ list: () => new Promise<Response>((resolve) => pending.push(resolve)) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() => expect(pending.length).toBe(1));

    // A second listing overtakes the first, and fails.
    fireEvent.focus(window);
    await waitFor(() => expect(pending.length).toBe(2));
    pending[1](json({ error: "boom" }, 500));
    expect(await screen.findByText(messages.briefListFailed("camp"))).toBeTruthy();

    // The older request now succeeds. Its data is stale: the newest thing we know is that
    // the store could not be read, so this answer must not quietly load the editor and
    // erase the failure. This is what the `try` generation guard is for — without it the
    // editor appears and this test goes red.
    pending[0](json({ briefs: [entry("camp", "r1")] }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(messages.briefListFailed("camp"))).toBeTruthy();
    expect(screen.queryByLabelText("Campaign Name")).toBeNull();
    error.mockRestore();
  });

  test("a stale answer that lands first does not settle the listing into a false not-found", async () => {
    const pending: Array<(r: Response) => void> = [];
    routes({ list: () => new Promise<Response>((resolve) => pending.push(resolve)) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() => expect(pending.length).toBe(1));

    // A second listing starts before the first answers — the mount load is now stale.
    fireEvent.focus(window);
    await waitFor(() => expect(pending.length).toBe(2));

    // The stale one answers first, and empty. It must not mark the listing settled:
    // that hands the route effect an empty listing with no failure recorded, and the
    // effect would then call setUnknownId on a brief that exists.
    pending[0](json({ briefs: [] }));
    // Flush the stale answer's state updates before asserting. A `waitFor` on a condition
    // that is already true returns without yielding, so the assertion would run before
    // React committed the false not-found — passing against the very bug it pins.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(messages.briefNotFound("camp"))).toBeNull();

    // The current answer decides.
    pending[1](json({ briefs: [entry("camp", "r1")] }));
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );
    expect(screen.queryByText(messages.briefNotFound("camp"))).toBeNull();
  });

  test("a slow failed answer cannot replace a newer successful one", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    const pending: Array<(r: Response) => void> = [];
    routes({ list: () => new Promise<Response>((resolve) => pending.push(resolve)) });
    renderWithRun(<Editor id="camp" />);

    await waitFor(() => expect(pending.length).toBe(1));
    pending[0](json({ error: "boom" }, 500));
    expect(await screen.findByText(messages.briefListFailed("camp"))).toBeTruthy();

    // Two retries in flight; the newer one answers first.
    await user.click(screen.getByRole("button", { name: messages.briefListFailedRetry }));
    await user.click(screen.getByRole("button", { name: messages.briefListFailedRetry }));
    await waitFor(() => expect(pending.length).toBe(3));
    pending[2](json({ briefs: [entry("camp", "r1")] }));
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    // The older, failed answer lands last — it must not take the page back.
    // NB what actually guarantees this: the route has loaded, so `routeLoadedId ===
    // routeId` short-circuits the effect and nulls `failedRouteId` regardless of the
    // generation stamp. This test pins the short-circuit, NOT the stamp — deleting the
    // stamp leaves it green (verified by mutation on PR #197). The stamp's real pins are
    // the two overlap tests, which act before the route has loaded.
    pending[1](json({ error: "boom" }, 500));
    await waitFor(() => expect(screen.queryByText(messages.briefListFailed("camp"))).toBeNull());
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp");
    error.mockRestore();
  });

  test("a slow successful answer cannot replace a newer one", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    const pending: Array<(r: Response) => void> = [];
    routes({ list: () => new Promise<Response>((resolve) => pending.push(resolve)) });
    renderWithRun(<Editor id="camp" />);

    await waitFor(() => expect(pending.length).toBe(1));
    pending[0](json({ error: "boom" }, 500));
    expect(await screen.findByText(messages.briefListFailed("camp"))).toBeTruthy();

    await user.click(screen.getByRole("button", { name: messages.briefListFailedRetry }));
    await user.click(screen.getByRole("button", { name: messages.briefListFailedRetry }));
    await waitFor(() => expect(pending.length).toBe(3));
    pending[2](json({ briefs: [entry("camp", "r1")] }));
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"),
    );

    // The older answer succeeds with an empty listing — it must not replace the
    // newer one, or the route-load effect would re-decide the id it just loaded
    // NB what actually guarantees this: the route has loaded, so `routeLoadedId ===
    // routeId` short-circuits the effect and nulls `failedRouteId` regardless of the
    // generation stamp. This test pins the short-circuit, NOT the stamp — deleting the
    // stamp leaves it green (verified by mutation on PR #197). The stamp's real pins are
    // the two overlap tests, which act before the route has loaded.
    // and answer a false not-found.
    pending[1](json({ briefs: [] }));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText(messages.briefNotFound("camp"))).toBeNull();
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp");
    error.mockRestore();
  });

  test("a Save-as whose listing refresh fails hands back a retryable failure state, never a false not-found", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const user = userEvent.setup();
    let listFails = false;
    const calls = routes({
      list: () =>
        listFails ? json({ error: "boom" }, 500) : json({ briefs: [entry("camp", "r1")] }),
      // The copy is created; the refresh adoptSavedCopy awaits on the way out fails.
      post: () => {
        listFails = true;
        return json({ file: "copy-1.yaml", brief: brief("copy-1"), revision: "mock-rev" }, 201);
      },
    });
    const view = renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy-1");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Failed to load briefs:", expect.anything()),
    );

    // The route moves to the copy (as it always does); the stale-failure honest answer
    // is the failure state — never not-found for a brief that was just created.
    view.rerender(
      <ShellProviders>
        <CreateCampaignProvider>
          <Editor id="copy-1" />
          <CreateCampaignDialog />
        </CreateCampaignProvider>
      </ShellProviders>,
    );
    expect(await screen.findByText(messages.briefListFailed("copy-1"))).toBeTruthy();
    expect(screen.queryByText(messages.briefNotFound("copy-1"))).toBeNull();
    expect(screen.queryByText(messages.briefNotFoundNew)).toBeNull();
    error.mockRestore();
  });
});

describe("the pre-type draft (T2 / D112)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  test("a draft saved before the type existed restores with the default (D112)", async () => {
    routes({});
    // What the previous build wrote: a state with no type keys at all — the
    // saved draft must normalise, not crash the mount or lose the name.
    saveDraftToStorage({ ...initialEditorState(), campaignName: "Restored" });
    const stored = JSON.parse(localStorage.getItem("cf:draft:new") as string) as {
      state: Record<string, unknown>;
    };
    delete stored.state.type;
    delete stored.state.typeExplicit;
    localStorage.setItem("cf:draft:new", JSON.stringify(stored));

    nextMock().nav.pathname = "/brief/new";
    renderWithRun(<NewEditor />);
    await waitFor(() =>
      expect((screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement).value).toBe(
        "Restored",
      ),
    );
    // The editor path, not only the unit: a restored pre-type draft must carry
    // the default on the state the autosave writes, not merely keep the name.
    await waitFor(() => {
      const restored = JSON.parse(localStorage.getItem("cf:draft:new") as string) as {
        state: { type?: string };
      };
      expect(restored.state.type).toBe("social-post");
    });
  });
});

describe("VE1 — undo and redo in the editor", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
  });

  const nameField = () => screen.getByLabelText(messages.campaignNameLabel) as HTMLInputElement;
  const audienceField = () =>
    screen.getByLabelText(messages.targetAudienceLabel) as HTMLInputElement;

  test("⌘Z steps back over a typed word; ⇧⌘Z replays it", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() => expect(nameField().value).toBe(""));
    await user.type(nameField(), "Spring");
    await waitFor(() => expect(nameField().value).toBe("Spring"));
    // One step back over the whole word, from outside the field: the editor owns
    // the chord only when no text field has the caret.
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    await waitFor(() => expect(nameField().value).toBe(""));
    fireEvent.keyDown(document.body, { key: "z", metaKey: true, shiftKey: true });
    await waitFor(() => expect(nameField().value).toBe("Spring"));
  });

  test("Ctrl+Z undoes where ⌘Z does", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() => expect(nameField().value).toBe(""));
    await user.type(nameField(), "Spring");
    fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    await waitFor(() => expect(nameField().value).toBe(""));
  });

  test("⌘Z inside a text field is left to the field's own undo", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() => expect(nameField().value).toBe(""));
    await user.type(nameField(), "Spring");
    // The caret is in the field: the chord belongs to the field's native undo.
    fireEvent.keyDown(nameField(), { key: "z", metaKey: true });
    expect(nameField().value).toBe("Spring");
    // The editor's stack is untouched — the same chord from outside steps back.
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    await waitFor(() => expect(nameField().value).toBe(""));
  });

  test("the route's load is a new baseline: ⌘Z after it does nothing", async () => {
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() => expect(nameField().value).toBe("camp"));
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    expect(nameField().value).toBe("camp");
  });

  test("the autosaved draft stays exactly EditorState's keys through an undo and a retype", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() => expect(nameField().value).toBe(""));
    await user.type(nameField(), "Spring");
    await user.type(audienceField(), "Family");
    // One step back undoes the audience run only — the name stands, so the
    // editor is still dirty and autosave writes the post-undo state.
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    await waitFor(() => expect(audienceField().value).toBe(""));
    await waitFor(() => expect(localStorage.getItem("cf:draft:new")).not.toBeNull());
    const stored = JSON.parse(localStorage.getItem("cf:draft:new") as string) as {
      state: Record<string, unknown>;
    };
    // History leaking into the persisted shape would come back through `restore`
    // as a phantom draft (R6): the object on disk is exactly what it was before VE1.
    expect(Object.keys(stored.state).sort()).toEqual(Object.keys(initialEditorState()).sort());
    expect(stored.state.campaignName).toBe("Spring");
  });

  test("undoing back to pristine purges the autosaved draft", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() => expect(nameField().value).toBe(""));
    await user.type(nameField(), "Spring");
    await waitFor(() => expect(localStorage.getItem("cf:draft:new")).not.toBeNull());
    // Undo steps every edit back: the draft is pristine again, so the recovery copy
    // holds nothing to recover — and a stale one would come back on reload with no
    // history left to undo it.
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    await waitFor(() => expect(nameField().value).toBe(""));
    await waitFor(() => expect(localStorage.getItem("cf:draft:new")).toBeNull());
  });

  test("a draft stored before mount is still offered for restore on mount", async () => {
    routes({});
    // A legacy-shaped draft: its visible content matches the pristine editor and it
    // carries the host verdict it saved with, so the restore it is offered lands
    // back on a pristine state — and the capabilities answer arriving a moment later
    // re-renders pristine again. A purge keyed on pristine ALONE fires on both, with
    // no diverging edit to undo and no re-save to bring the draft back: the mount
    // eats the very draft the mount came for. The return-to-pristine purge must
    // know this render is the START, not a RETURN.
    saveDraftToStorage({ ...initialEditorState(), capabilities: { motion: true } });
    renderWithRun(<NewEditor />);
    await waitFor(() => expect(nameField().value).toBe(""));
    // Let the capabilities answer land and its (still-pristine) render flush.
    await new Promise((r) => setTimeout(r, 50));
    // Still there — and still the draft that was stored, not a rewrite of it: the
    // mount read it and left it alone until something diverges.
    const stored = JSON.parse(localStorage.getItem("cf:draft:new") ?? "null") as {
      state: { capabilities: unknown };
    } | null;
    expect(stored?.state.capabilities).toEqual({ motion: true });
  });

  test("⌘Z inside an open dialog does not edit the draft behind it", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() => expect(nameField().value).toBe(""));
    await user.type(nameField(), "Spring");
    await saveVia(user, "Save as");
    const dialog = await screen.findByRole("dialog", { name: /Save as/ });
    // Focus sits on one of the dialog's buttons: the chord belongs to the open
    // dialog, never to the draft underneath the scrim.
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "Cancel" }), {
      key: "z",
      metaKey: true,
    });
    expect(nameField().value).toBe("Spring");
    // Wherever the chord lands while the modal is open — here the document body,
    // as after a click on the scrim — the page behind an aria-modal dialog is inert:
    // the draft must not move.
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(nameField().value).toBe("Spring");
    // Close the dialog: the editor stack was untouched all along, so the same chord
    // now steps back.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Save as/ })).toBeNull());
    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    await waitFor(() => expect(nameField().value).toBe(""));
  });
});
