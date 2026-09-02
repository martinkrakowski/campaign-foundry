import { describe, test, expect, beforeEach, vi } from "vitest";
import * as messages from "@/components/campaign/messages";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun, json, nextMock, ShellProviders } from "@/__tests__/helpers";
import { API, useRun } from "@/lib/run-context";
import type { BriefEntry } from "@/lib/briefs-api";
import { fromBrief, saveDraftToStorage } from "@/components/campaign/editor-state";
import { sectionOrder, SECTION_TITLES } from "@/components/campaign/sections";
import { BriefEditor } from "@/components/campaign/BriefEditor";
import NewBriefPage from "../new/page";
import { Header } from "@/components/shell/Header";

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

const brief = (id: string) => ({
  id,
  targetRegion: "DE",
  targetAudience: "a",
  campaignMessage: "Hi",
  products: [
    { id: "alpha", name: "A", primaryColor: "#1473E6", logoPath: "a.png" },
    { id: "beta", name: "B", primaryColor: "#E0218A", logoPath: "b.png" },
  ],
});

const entry = (id: string, revision?: string) => ({ file: `${id}.yaml`, brief: brief(id), revision });

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
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
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
        handlers.put?.(u, parsed) ?? json({ file: "x.yaml", brief: brief("x"), revision: "mock-rev" }),
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
 * So these tests assert what they mean — nothing was written — rather than the stricter
 * statement that no request of any kind was issued. Any other non-GET, including a stray
 * /campaigns/generate, still fails.
 */
const writes = (calls: readonly { url: string; method: string }[]) =>
  calls.filter((c) => c.method !== "GET" && !c.url.includes("/campaigns/plan"));

const waitForEditorReady = async () =>
  waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).not.toBe(""));

const fillValidDraft = async (user: ReturnType<typeof userEvent.setup>, id = "fresh") => {
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

describe("BriefPage — data flow", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
    // W6: the editor's default presentation is Guided, but everything this suite
    // describes (stacked sections, sidebar policy) is the Everything presentation —
    // so seed it, and let the Guided tests below override per-test.
    localStorage.setItem("cf:presentation", "everything");
  });

  test("loads the brief list on mount and again when the window regains focus", async () => {
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor />);

    await waitFor(() => expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(0));
    const onMount = calls.filter((c) => c.method === "GET").length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(onMount));
  });

  test("a failing list is logged rather than thrown", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    routes({ list: () => json({ error: "boom" }, 500) });
    renderWithRun(<Editor />);
    await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to load briefs:", expect.anything()));
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
    view.rerender(<ShellProviders><Editor id="camp" /></ShellProviders>);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));

    await fillValidDraft(user);

    await waitFor(() =>
      expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(false),
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
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }), put: () => json({ error: "conflict" }, 409) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

    const save = screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await user.click(save);

    // In flight: the button is disabled and wears `aria-busy` (the isLoading render
    // replaces its label with the spinner, so find it by the busy state). This is the
    // only thing that closes the verb off — an invalid draft never does (D3).
    await waitFor(() => {
      const busy = screen.getAllByRole("button").find((b) => b.getAttribute("aria-busy") === "true");
      expect(busy).toBeTruthy();
      expect((busy as HTMLButtonElement).disabled).toBe(true);
    });

    release();
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Save$/ })).toBeTruthy());
    expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("Save as... creates a copy under the new id and closes the dialog", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    await waitFor(() => expect(screen.queryByLabelText("New brief id")).toBeNull());
  });

  test("a failed Save as... keeps the dialog open and shows why", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }), post: () => json({ error: "already exists" }, 409) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

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
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByLabelText("New brief id")).toBeNull();
  });

  test("New brief... asks for the blank route rather than emptying the form in place", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

    // reopen the selector and choose the create-new row
    await user.click(screen.getAllByText("camp")[0]);
    await user.click(screen.getByText("New brief..."));
    expect(nextMock().router.push).toHaveBeenCalledWith("/brief/new");
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
  });

  test("New brief... on the blank route empties the form in place", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));
    await fillValidDraft(user, "typed");
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("typed");

    // there is nowhere to navigate to from here, so the row has to do the work itself
    // (the router mock is shared across this file, so count pushes rather than assert
    // it was never called)
    const pushesBefore = nextMock().router.push.mock.calls.length;
    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(screen.getAllByText("New brief...").slice(-1)[0]);

    // The dirty draft is asked through the editor's replace dialog (the shell's
    // "Unsaved edits" pattern, two-phase since window.confirm retired): exactly one
    // prompt, and Discard is the consent that throws the draft away.
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(screen.getAllByRole("dialog", { name: "Unsaved edits" })).toHaveLength(1);
    await user.click(within(prompt).getByRole("button", { name: messages.confirmDialogDiscard }));

    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));
    expect((screen.getByLabelText("Target Region") as HTMLInputElement).value).toBe("");
    expect(nextMock().router.push.mock.calls.length).toBe(pushesBefore);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull());

    // H6: the blank route's draft key is stable, so the reset had to purge the
    // discarded draft — otherwise a reload at this route would resurrect it.
    await waitFor(() => {
      const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
      expect(keys.filter((k) => k.startsWith("cf:draft:"))).toEqual([]);
    });
  });

  test("a clean editor's New brief resets in place without asking", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));

    // A pristine draft has nothing to lose: the replace confirmation never opens.
    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(screen.getAllByText("New brief...").slice(-1)[0]);
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
  });

  test("declining the prompt keeps what was typed on the blank route", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));
    await fillValidDraft(user, "typed");

    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(screen.getAllByText("New brief...").slice(-1)[0]);

    // The refusal (Stay) is inert: no navigation, and the draft keeps the edits
    // the user declined to throw away.
    const prompt = await screen.findByRole("dialog", { name: "Unsaved edits" });
    await user.click(within(prompt).getByRole("button", { name: messages.confirmDialogStay }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull());
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("typed");
  });

  test("Save as... on the blank route also stops the URL calling it new", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));
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
    view.rerender(<ShellProviders><Editor id="copy" /></ShellProviders>);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("copy"));

    // saving the copy must send the revision the POST handed back; without it the write
    // silently drops to last-write-wins, the trap `loadBrief` carries the revision to avoid
    await saveVia(user, "Save");
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.url.includes("revision=rev-copy"))).toBe(true),
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
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

    // the id is taken (the listing knows it): the overwrite dialog asks, and the
    // user's accept is what retries with ?replace=1 (D9)
    const prompt = await screen.findByRole("dialog", { name: messages.saveAsOverwriteTitle });
    await user.click(within(prompt).getByRole("button", { name: messages.saveAsOverwriteConfirm }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url.includes("replace=1"))).toBe(true));

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
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }), post: () => new Promise<Response>(() => {}) });
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
    expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("Save as... offers the slugified form of a name as a click, never a silent rewrite", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "Trail Blaze 2026");
    await user.click(
      await screen.findByRole("button", { name: 'Try "trail-blaze-2026" instead' }),
    );

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

    await saveVia(user, "Save");
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  });

  test("a 409 on a first-time save has no baseline to adopt the fresh revision against", async () => {
    const user = userEvent.setup();
    routes({
      post: () => json({ error: 'Brief "fresh" already exists.', revision: "rev-fresh" }, 409),
    });
    renderWithRun(<NewEditor />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));
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
      source: { kind: "file", file: "camp.yaml", loadedId: "camp", savedSnapshot: null, revision: "r1" },
    });
    routes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      put: () => json({ error: "Brief was modified by another user.", revision: "rev-fresh" }, 409),
    });
    renderWithRun(<Editor id="camp" />);
    // the route loads camp, then draft recovery restores the orphan over it
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    view.rerender(<ShellProviders><Editor id="copy" /></ShellProviders>);

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));
    await fillValidDraft(user, "fresh");

    // The editor publishes the differing draft; Generate asks instead of running the
    // previous campaign silently.
    await user.click(screen.getByRole("button", { name: "Generate" }));
    const dialog = await screen.findByRole("dialog", { name: messages.generateDraftTitle });
    // Exactly one prompt: the guard's "Unsaved edits" is nowhere behind the question.
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: new RegExp(`^${messages.generateDraftRunThis}`) }));

    // The on-screen draft was POSTed — not the shell's (empty) brief...
    const generatePost = await waitFor(() => {
      const call = calls.find((c) => c.url.includes("/campaigns/generate"));
      expect(call).toBeTruthy();
      return call!;
    });
    expect((generatePost.body as { id?: string }).id).toBe("fresh");
    // ...and zero brief writes left the page: run-without-write.
    expect(calls.filter((c) => c.method !== "GET" && c.url.includes("/campaigns/briefs"))).toEqual([]);
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
    await waitFor(() => expect(JSON.parse(localStorage.getItem("cf:brief") ?? "null")?.id).toBe("camp"));
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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

    await user.click(screen.getByRole("button", { name: messages.editorCancel }));
    expect(nextMock().router.push).toHaveBeenCalledWith("/grid");
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();
  });

  test("Revert restores the last saved state, after asking through the replace confirmation", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));
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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));
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
    const strip = Array.from(
      document.querySelectorAll<HTMLElement>("button.rounded-full"),
    ).find((b) => /Identity/.test(b.textContent ?? "")) as HTMLElement;
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
          axes: { layout: ["headline-top"], tone: ["bold"], background: { source: ["procedural"] }, paletteShift: [0] },
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

    const chip = Array.from(document.querySelectorAll<HTMLElement>("button.rounded-full")).find((b) =>
      /Policy/.test(b.textContent ?? ""),
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
      brief: { ...brief("clip"), output: { formats: ["static", "motion"], platforms: ["linkedin"] } },
    };
    routes({ list: () => json({ briefs: [motion] }) });
    renderWithRun(<Editor id="clip" />);

    const chip = await waitFor(() => {
      const found = Array.from(document.querySelectorAll<HTMLElement>("button.rounded-full")).find((b) =>
        /Motion/.test(b.textContent ?? ""),
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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));
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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(false);

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

  test("Save as… onto an existing id asks before overwriting, and honours a refusal", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => false);
    const calls = routes({ list: () => json({ briefs: [entry("taken", "r1")] }) });
    renderWithRun(<NewEditor />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));

    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "taken");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));

    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "taken");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

    // the dialog is the decision point; the confirm is what sends the overwrite
    const prompt = await screen.findByRole("dialog", { name: messages.saveAsOverwriteTitle });
    await user.click(within(prompt).getByRole("button", { name: messages.saveAsOverwriteConfirm }));

    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.url).toContain("replace=1"));
  });

  test("a 409 from a brief that appeared since the list was fetched offers the same overwrite", async () => {
    const user = userEvent.setup();
    let posts = 0;
    const calls = routes({
      post: () => {
        posts += 1;
        return posts === 1 ? json({ error: "already exists" }, 409) : json({ file: "copy.yaml", brief: brief("copy") }, 201);
      },
    });
    renderWithRun(<NewEditor />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));

    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));

    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));

    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "taken");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));

    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/disk full/)).toBeTruthy();
  });

  test("a route brief is re-attached to its file when the listing knows it", async () => {
    const calls = routes({ list: () => json({ briefs: [entry("summer-hydration-2026", "rev-live")] }) });
    renderWithRun(<Editor id="summer-hydration-2026" />);

    // the route's brief arrives with the entry's file identity, so the editor can
    // save conditionally rather than as a new draft
    await waitFor(() => expect(screen.getByLabelText("Campaign Name").hasAttribute("readonly")).toBe(true));

    const user = userEvent.setup();
    await saveVia(user, "Save");
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.url).toContain("revision=rev-live"));
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
          axes: { layout: ["headline-top"], tone: ["bold"], background: { source: ["procedural"] }, paletteShift: [0] },
        },
      },
    };
    routes({ list: () => json({ briefs: [randomized] }) });
    renderWithRun(<Editor id="rand" />);
    await waitFor(() => expect(document.querySelector('[data-section="policy"], #policy')).toBeTruthy());

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
    localStorage.setItem("cf:presentation", "everything");
  });

  const motionToggle = () => screen.getByRole("button", { name: "motion" }) as HTMLButtonElement;

  test("a 'not probed' snapshot is retried — the retry's verdict, not the snapshot, gates motion", async () => {
    let calls = 0;
    routes({
      capabilities: () => {
        calls += 1;
        return calls <= 1 ? json({ motion: false, reason: "not probed" }) : json({ motion: false, reason: "no ffmpeg" });
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

    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("clip"));
    // Under per-card gating (L4.4), motion kinds remain operable; the video format card
    // carries the capability gate description
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "ken-burns-in" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(motionToggle().disabled).toBe(false);

    // D7: the brief is unrunnable here but still savable, so Save & apply is enabled —
    // and having applied it, it owes the user the same reason Apply gives.
    const save = screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    await saveVia(user, "Save");

    // the Output section already shows this as a field error; the notice is the
    // separate status the action bar owes after applying
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toBe(messages.statusApplyRefusal);
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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));
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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));
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
    expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(false);
    // The control named "Save" opens the menu; the verb a user actually presses is inside
    // it. Clicking only the menu button proved nothing here — this assertion passed with
    // the refusal removed entirely, because opening a menu never writes.
    await saveVia(user, "Save");
    expect(writes(calls)).toEqual([]);
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

    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("clip"));

    // the probe's verdict lands and Video card shows capability description. Under per-card
    // gating (L4.4), motion kinds remain operable and the format toggle stays operable.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "ken-burns-in" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(motionToggle().disabled).toBe(false);
    expect(screen.getByText(messages.formatsMotionUnavailable)).toBeTruthy();
    expect((screen.getByRole("button", { name: "ken-burns-in" }) as HTMLButtonElement).disabled).toBe(false);
    const slider = screen.getByRole("slider", { name: "Duration 1 (seconds)" });
    expect(slider).toBeTruthy();
    expect(slider.getAttribute("aria-valuenow")).toBe("6");
    expect((screen.getByRole("button", { name: "instagram-reel" }) as HTMLButtonElement).disabled).toBe(true);

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
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(messages.statusApplyRefusal));
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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("odd"));

    expect(
      await screen.findByText(
        messages.platformsIncompatible("Instagram Reel", ["Video"]),
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(false),
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
    const section = document.querySelector('#identity, [data-section="identity"]') as HTMLElement | null;
    expect(section).not.toBeNull();
    expect(document.activeElement).toBe(section);
  });


  test("an outline row whose section has left the page does nothing", async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor id="camp" />);
    const row = await screen.findByRole("button", { name: "Identity" });
    // Delete the target first: the row then has nothing to hand focus to, which is the
    // branch a real page reaches when a section is unmounted (guided mode, later).
    document.querySelectorAll('#identity, [data-section="identity"]').forEach((el) => el.remove());
    await user.click(row);
    expect(document.querySelector('#identity, [data-section="identity"]')).toBeNull();
    // Focus stays on the row the user pressed; nothing else is grabbed. (A click focuses
    // its own button, so the meaningful assertion is that no section took focus.)
    expect(document.activeElement).toBe(row);
  });

});

describe("BriefPage — guided presentation (W6)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
    localStorage.setItem("cf:presentation", "guided");
  });

  // A classic brief that meets every step, so Next can walk all the way to Review.
  const complete = (id: string) => ({
    ...brief(id),
    output: { formats: ["static"], platforms: ["linkedin"] },
  });

  // D37: adopting a brief IS arriving at its route — wait for the route's brief to land.
  // D37: adopting a brief IS arriving at its route — wait for the route's brief to
  // land, and for the first step's validation to have settled: the ready ring fires
  // once the loaded brief's first step became complete, and its remount is the
  // exact window in which a click on Next is lost (L2). Waiting here drains that
  // cascade before any test clicks.
  const adopt = async (_user: ReturnType<typeof userEvent.setup>, id: string) => {
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(id));
    await waitFor(() => expect(document.querySelector(".animate-ready-ring")).toBeTruthy());
  };

  const stepHeading = () => screen.getByRole("heading", { level: 1 });
  const next = () => screen.getByRole("button", { name: messages.stepNext });
  const back = () => screen.getByRole("button", { name: messages.stepBack });
  const footerStatus = () =>
    (document.querySelector('footer [role="status"]') as HTMLElement | null)?.textContent;

  test("guided shows one section at a time, with the StepHeader in place of the row's chip", async () => {
    // No stored choice: the default is Guided. (This describe's beforeEach seeds
    // "guided", so drop the key to exercise the unset fallback.)
    localStorage.removeItem("cf:presentation");
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // Only the Identity step is mounted; the rest of the stack is not in the DOM.
    expect(stepHeading().textContent).toBe("Identity");
    expect(document.getElementById("identity")).toBeTruthy();
    expect(document.getElementById("products")).toBeNull();

    // First step: no Back, Next present, both verbs live.
    expect(screen.queryByRole("button", { name: messages.stepBack })).toBeNull();
    expect(next()).toBeTruthy();

    // The status chip moved into the StepHeader, and the toggle mirrors the mode.
    expect(screen.getByRole("group", { name: messages.presentationLabel })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: messages.presentationGuided }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(footerStatus()).toBe(messages.statusStepReady);
  });

  test("broken presentation storage falls back to Guided", async () => {
    // Storage that throws is the same fallback as an absent key: a read that reaches
    // storage but has nothing valid to give is indistinguishable from one that cannot
    // reach it. The suite's localStorage is the in-memory stand-in from vitest.setup,
    // so spy on that object, not on the Web platform's Storage.prototype. The picker
    // (adopt) still needs real reads for its own keys, so only trip the probe key.
    const realGet = globalThis.localStorage.getItem.bind(globalThis.localStorage);
    const spy = vi.spyOn(globalThis.localStorage, "getItem").mockImplementation((key: string) => {
      if (key === "cf:presentation") throw new Error("storage gone");
      return realGet(key);
    });
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");
    expect(stepHeading().textContent).toBe("Identity");
    spy.mockRestore();
  });

  test("a refused Next keeps the step, reveals its errors and replays the nudge", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // Identity is the step that stands in the way: an empty region is an error the
    // loaded brief does not carry until the field is cleared.
    await user.clear(screen.getByLabelText("Target Region"));
    await user.click(next());

    // Still on Identity, now speaking what it needs: the footer says the first error.
    expect(stepHeading().textContent).toBe("Identity");
    expect(footerStatus()).toBe(messages.targetRegion);
    // The refused Next replayed the one-shot nudge on the Next label. (W7.4 owns the
    // keyframe now, and named it with the rest of the one-shots.)
    const label = next().querySelector("span");
    expect(label?.className).toContain("animate-nudge");
  });

  test("the wizard stays on Review across the route change a save causes (H5)", async () => {
    // The user's original report: "Clicking on the last wizard screen takes user back
    // to the first slide, with no indication as to why." R6 retired the verb they
    // pressed; the bounce survived on the SUCCESS path. A save that renames the route
    // (a first save, or Save as…) moves /brief/new or /brief/{id} to a different
    // segment, so Next unmounts one page component and mounts another — and the step
    // cursor, plain useState, is rebuilt from zero.
    const user = userEvent.setup();
    let listed: BriefEntry[] = [entry("ok", "r1")];
    routes({
      list: () => json({ briefs: listed }),
      post: (_url, body) => {
        const stored = { file: "copy.yaml", brief: body as never, revision: "rev-copy" };
        listed = [...listed, stored];
        return json(stored, 201);
      },
    });
    const view = renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Copy"));
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Products"));
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Treatments"));
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Layout"));
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Output"));
    await user.click(screen.getByRole("button", { name: messages.stepNextReview }));
    await waitFor(() => expect(stepHeading().textContent).toBe("Review"));

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/brief/copy"));

    // Next answers that replace by swapping the segment: the old page unmounts and the
    // new one mounts in its place. Simulated here, because the test renders pages.
    view.unmount();
    renderWithRun(<Editor id="copy" />);

    // They pressed Save on the last screen; they should still be looking at it.
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Review"));
  });

  test("walk to Review: each Next lands on the next step and hands the step heading focus", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // Identity (step 1 of 7) -> Copy; the heading is the focus handoff target.
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Copy"));
    expect(document.activeElement).toBe(stepHeading());
    expect(back()).toBeTruthy();

    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Products"));
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Treatments"));
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Layout"));
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Output"));

    // The last section step's Next says what it leads to. (Corrected for D35: the
    // label was "Review & launch", promising a launch the review step does not carry.)
    const finish = screen.getByRole("button", { name: messages.stepNextReview });
    expect(finish.textContent).toBe(messages.stepNextReview);
    await user.click(finish);
    await waitFor(() => expect(stepHeading().textContent).toBe("Review"));

    // Review: no Next — this is the last look, already on screen.
    expect(screen.queryByRole("button", { name: messages.stepNext })).toBeNull();
    expect(back()).toBeTruthy();
    expect(screen.getByText(messages.stepReviewIntro)).toBeTruthy();
    expect(footerStatus()).toBe(messages.statusStepReview);
  });

  test("variation walks to the Policy step, and the Copy step can open the headline pool", async () => {
    const user = userEvent.setup();
    const randomizedBrief = {
      ...complete("rand"),
      mode: "variation" as const,
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
        },
      },
    };
    routes({ list: () => json({ briefs: [{ file: "rand.yaml", revision: "r1", brief: randomizedBrief }] }) });
    renderWithRun(<Editor id="rand" />);
    await adopt(user, "rand");

    // Identity -> Copy.
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Copy"));

    // On the Copy step (variation) the headline pool is one click away.
    await user.click(screen.getByRole("button", { name: new RegExp(messages.moreIdeas) }));
    expect(screen.getByRole("heading", { level: 3, name: "Headline Pool" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Close/ }));

    // Copy -> Products -> Layout -> Output -> Policy: the variation order skips
    // treatments, and the Layout step (T7) carries the template before Output.
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Products"));
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Layout"));
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Output"));
    // Corrected: this asserted that Output's Next reads "Review & launch" in
    // randomized mode, which pinned the defect — Output is the last section step in
    // *classic* only, and here it is followed by Variation Policy. The launch label
    // belongs to whichever step is actually last.
    expect(screen.queryByRole("button", { name: messages.stepNextReview })).toBeNull();
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Variation Policy"));
    expect(footerStatus()).toBe(messages.statusStepReady);

    // Policy *is* last here, so it is the step that offers the launch.
    await user.click(screen.getByRole("button", { name: messages.stepNextReview }));
    await waitFor(() => expect(stepHeading().textContent).toBe("Review"));
  });

  test("the Asset Bin drawer is hoisted out of the step card (M7)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // Identity -> Copy -> Products, where the bin is one click away per product.
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Copy"));
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Products"));

    await user.click(screen.getAllByRole("button", { name: messages.logoChooseFromBin })[0]);
    const drawer = await screen.findByRole("dialog", { name: "Asset Bin" });

    // M7's structural fact: the step card carries a permanent non-`none` transform
    // (the walk's animation container), which makes it the CONTAINING BLOCK for
    // `fixed` descendants — a drawer nested inside it would be trapped in the card.
    // The drawer's node therefore lives outside it, at the editor's root.
    const stepCard = document.querySelector('[data-testid="step-card"]');
    expect(stepCard).toBeTruthy();
    expect(stepCard!.contains(drawer)).toBe(false);
    // happy-dom applies no layout, so "the scrim covers the viewport" is not
    // provable here — the visual half of M7 is verified in a browser. This test
    // pins the structural half the fix consists of.
  });

  test("picking an asset in the hoisted bin still fills the product's logo", async () => {
    const user = userEvent.setup();
    // The same fetch mock routes() installs, plus the bin's listing endpoint — the
    // hoisted drawer fetches against the brief's id exactly as it did in the section.
    vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
      const u = String(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (u.includes("/campaigns/assets")) {
        return Promise.resolve(json({ assets: [{ name: "brand-logo.png", size: 4096, type: "image/png" }] }));
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

    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Copy"));
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Products"));

    await user.click(screen.getAllByRole("button", { name: messages.logoChooseFromBin })[0]);
    await screen.findByRole("dialog", { name: "Asset Bin" });
    await user.click(await screen.findByRole("button", { name: "Choose brand-logo.png" }));

    // the selection rode the hoisted drawer: the product's logo is the bin asset…
    const logos = () =>
      screen
        .getAllByLabelText("Logo Path")
        .filter((el) => el.tagName === "INPUT" && el.getAttribute("type") !== "file");
    await waitFor(() => expect((logos()[0] as HTMLInputElement).value).toBe("assets/inputs/ok/brand-logo.png"));
    // …and the drawer closed with the choice, the way the in-section drawer did.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Asset Bin" })).toBeNull());
  });

  test("the presentation toggle stays reachable from Everything", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    await user.click(screen.getByRole("button", { name: messages.presentationEverything }));

    // The group used to carry `hidden` in this presentation, and the choice persists —
    // so Guided became unreachable for good, including across a reload. jsdom applies
    // no CSS, so a role query still found the button and every test passed; the class
    // is the only thing that can be asserted here.
    const group = screen.getByRole("group", { name: messages.presentationLabel });
    expect(group.className).not.toContain("hidden");
    await user.click(screen.getByRole("button", { name: messages.presentationGuided }));
    expect(
      screen.getByRole("button", { name: messages.presentationGuided }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  test("Back returns to the previous step, and disappears again on the first", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Copy"));
    await user.click(back());
    await waitFor(() => expect(stepHeading().textContent).toBe("Identity"));
    expect(screen.queryByRole("button", { name: messages.stepBack })).toBeNull();
  });

  test("an unmounted ErrorStrip chip switches the step first, then scrolls — and leaves focus alone", async () => {
    const user = userEvent.setup();
    const scroller = vi.fn();
    Element.prototype.scrollIntoView = scroller;
    // Products is invalid, so its chip is visible from the identity step.
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

    // Corrected for W8.2: the action bar (and the ErrorStrip inside it) stands on the
    // Review step in Guided — it is no longer mounted on every step — so the chip is
    // met from Review, reached by the segbar's own name for it, never by position.
    const segbar = within(screen.getByRole("navigation", { name: messages.segBarLabel }));
    await user.click(segbar.getByRole("button", { name: /: Review, / }));
    await waitFor(() => expect(stepHeading().textContent).toBe("Review"));

    const chip = Array.from(document.querySelectorAll<HTMLElement>("button.rounded-full")).find((b) =>
      /Products/.test(b.textContent ?? ""),
    ) as HTMLElement;
    expect(chip).toBeTruthy();
    await user.click(chip);

    // The step switched to Products (the section was unmounted at click time)…
    await waitFor(() => expect(stepHeading().textContent).toBe("Products"));
    expect(document.getElementById("products")).toBeTruthy();
    // …and the deferred scroll found it once it existed — once, not repeatedly.
    // `toHaveBeenCalled()` alone is this repo's known decorative assertion.
    expect(scroller).toHaveBeenCalledTimes(1);
    // The reveal stayed scroll-only: nothing grabbed focus for itself. (Corrected
    // alongside the placement: the chip unmounts with the Review card it stands on,
    // so focus falls to the body — the invariant is that neither the section nor the
    // step heading took it.)
    await waitFor(() => expect(document.activeElement).not.toBe(stepHeading()));
    expect(document.activeElement).not.toBe(document.getElementById("products"));
  });

  test("an outline row on another step switches the step and hands the section focus", async () => {
    const user = userEvent.setup();
    const scroller = vi.fn();
    Element.prototype.scrollIntoView = scroller;
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // The complete brief leaves the StatusLine link-free, so the outline's row is the
    // only button named exactly "Products".
    const row = await screen.findByRole("button", { name: "Products" });
    await user.click(row);

    await waitFor(() => expect(stepHeading().textContent).toBe("Products"));
    const section = document.getElementById("products") as HTMLElement;
    expect(section).toBeTruthy();
    expect(scroller).toHaveBeenCalled();
    // The outline's activation asked for focus — the section takes it, not the heading.
    expect(document.activeElement).toBe(section);
  });

  test("the toggle switches and persists the presentation, and restores the row's chip", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");
    expect(screen.queryByRole("button", { name: messages.presentationGuided })?.getAttribute("aria-pressed")).toBe(
      "true",
    );

    await user.click(screen.getByRole("button", { name: messages.presentationEverything }));
    await waitFor(() => expect(document.getElementById("products")).toBeTruthy());
    // Everything stacks the sections and moves the status chip back into the header row.
    expect(document.getElementById("identity")).toBeTruthy();
    expect(screen.getByRole("group", { name: messages.presentationLabel })).toBeTruthy();
    expect(localStorage.getItem("cf:presentation")).toBe("everything");

    await user.click(screen.getByRole("button", { name: messages.presentationGuided }));
    await waitFor(() => expect(document.getElementById("products")).toBeNull());
    expect(stepHeading().textContent).toBe("Identity");
  });

  test("a presentation write that cannot reach storage does not break the toggle", async () => {
    const realSet = globalThis.localStorage.setItem.bind(globalThis.localStorage);
    const spy = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation((key: string, value: string) => {
      if (key === "cf:presentation") throw new Error("storage gone");
      return realSet(key, value);
    });
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    await user.click(screen.getByRole("button", { name: messages.presentationEverything }));
    await waitFor(() => expect(document.getElementById("products")).toBeTruthy());
    spy.mockRestore();
  });

  test("the policy sidebar renders only for Everything; Guided keeps it on its step", async () => {
    const user = userEvent.setup();
    const randomizedBrief = {
      ...complete("rand"),
      mode: "variation",
      variation: {
        count: 0,
        axes: { layout: ["headline-top"], tone: ["bold"], background: { source: ["procedural"] }, paletteShift: [0] },
      },
    };
    routes({ list: () => json({ briefs: [{ file: "rand.yaml", revision: "r1", brief: randomizedBrief }] }) });
    renderWithRun(<Editor id="rand" />);
    await adopt(user, "rand");

    // Guided: no policy panel in the sidebar — policy is a step (reached after Output).
    // The sidebar panel is the element carrying data-section="policy" (its own capture
    // for touched-section tracking); the outline row names the section elsewhere.
    expect(document.querySelector('[data-section="policy"]')).toBeNull();
    await user.click(screen.getByRole("button", { name: messages.presentationEverything }));
    await waitFor(() => expect(document.querySelector('[data-section="policy"]')).toBeTruthy());
  });
});

describe("BriefPage — the walk's chrome and gestures (W7)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
    localStorage.setItem("cf:presentation", "guided");
  });

  // D37: adopting a brief IS arriving at its route — wait for the route's brief to land.
  // D37: adopting a brief IS arriving at its route — wait for the route's brief to
  // land, and for the first step's validation to have settled: the ready ring fires
  // once the loaded brief's first step became complete, and its remount is the
  // exact window in which a click on Next is lost (L2). Waiting here drains that
  // cascade before any test clicks.
  const adopt = async (_user: ReturnType<typeof userEvent.setup>, id: string) => {
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(id));
    await waitFor(() => expect(document.querySelector(".animate-ready-ring")).toBeTruthy());
  };

  const stepHeading = () => screen.getByRole("heading", { level: 1 });
  const next = () => screen.getByRole("button", { name: messages.stepNext });
  const segbar = () => within(screen.getByRole("navigation", { name: messages.segBarLabel }));
  const segments = () => segbar().getAllByRole("button");
  const card = () => screen.getByTestId("step-card");
  /** The walk's length, derived from the one list the editor derives it from (W6.1). */
  const walkLength = sectionOrder("brief").length + 1;

  /** The step-card animation classes on screen right now (W7.2). */
  const cardMotion = () =>
    Array.from(document.querySelectorAll("[class]"))
      .flatMap((element) => Array.from(element.classList))
      .filter((token) => /^step-(enter|exit)-/.test(token))
      .sort();

  test("the segbar names one segment per step, and any segment navigates", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // As long as the step list for this mode — never a number the segbar knows: it
    // maps the list the cursor already walks (W6.1), and the count follows it.
    expect(segments()).toHaveLength(walkLength);
    expect(segments()[0].getAttribute("aria-current")).toBe("step");
    expect(segments()[0].getAttribute("aria-label")).toBe(
      messages.segBarSegment(1, walkLength, "Identity", "current"),
    );

    // The review step, from the first step, without having walked there: no lock
    // (D21). A segment is never disabled, so it never needs a reason off-screen.
    await user.click(segments()[sectionOrder("brief").length]);
    await waitFor(() => expect(stepHeading().textContent).toBe("Review"));
    expect(segments()[sectionOrder("brief").length].getAttribute("aria-current")).toBe("step");
  });

  test("a segment for a step with something to fix says so, and still navigates", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");
    // Identity is the step with the problem: the region field was emptied.
    await user.clear(screen.getByLabelText("Target Region"));

    // Walk by the segbar: Next would refuse (W6), and a segment is not a gate.
    await user.click(segments()[1]);
    await waitFor(() => expect(stepHeading().textContent).toBe("Copy"));
    expect(segments()[0].getAttribute("aria-label")).toBe(
      messages.segBarSegment(1, walkLength, "Identity", "issues"),
    );

    // …and the step behind it still answers a click, straight back to the problem.
    await user.click(segments()[0]);
    await waitFor(() => expect(stepHeading().textContent).toBe("Identity"));
  });

  test("the arrow keys walk, and stop walking inside a text field", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // A left arrow in a text field moves the caret. The walk listens on the window,
    // so an unsuppressed listener would turn the page out from under the typing.
    const name = screen.getByLabelText("Campaign Name");
    await user.click(name);
    await user.keyboard("{ArrowLeft}{ArrowRight}");
    expect(stepHeading().textContent).toBe("Identity");
    expect(document.activeElement).toBe(name);

    // Nothing is disabled for the field's sake: the caret is what moved, and the
    // moment focus leaves the field the keys are the walk's again.
    await user.click(stepHeading());
    await user.keyboard("{ArrowRight}{ArrowRight}");
    await waitFor(() => expect(stepHeading().textContent).toBe("Products"));
    await user.keyboard("{ArrowLeft}");
    await waitFor(() => expect(stepHeading().textContent).toBe("Copy"));
  });

  test("the arrow keys stay out of an open dialog", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // Corrected for W8.2: the bar (and the Save verb it carries) stands on the Review
    // step in Guided, so the dialog is opened from there.
    await user.click(segments()[walkLength - 1]);
    await waitFor(() => expect(stepHeading().textContent).toBe("Review"));

    // The save-as dialog, open: every overlay in the app mounts on open, so one in
    // the DOM is one on screen. The key is aimed at the dialog itself, not at its
    // field, so what stops the walk is the overlay — not the typing rule.
    await saveVia(user, "Save as");
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(stepHeading().textContent).toBe("Review");
  });

  test("a swipe across the step card walks; a tap does not", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // 12px of drift is not a gesture anyone made on purpose.
    fireEvent.touchStart(card(), { changedTouches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchEnd(card(), { changedTouches: [{ clientX: 188, clientY: 302 }] });
    await waitFor(() => expect(stepHeading().textContent).toBe("Identity"));

    // Dragging left pulls the next step in, the way a page turn does.
    fireEvent.touchStart(card(), { changedTouches: [{ clientX: 200, clientY: 300 }] });
    fireEvent.touchEnd(card(), { changedTouches: [{ clientX: 80, clientY: 310 }] });
    await waitFor(() => expect(stepHeading().textContent).toBe("Copy"));

    // …and back again.
    fireEvent.touchStart(card(), { changedTouches: [{ clientX: 80, clientY: 300 }] });
    fireEvent.touchEnd(card(), { changedTouches: [{ clientX: 260, clientY: 305 }] });
    await waitFor(() => expect(stepHeading().textContent).toBe("Identity"));
  });

  test("a step change slides the arriving card in and takes the leaving card out of flow", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    await user.click(next());
    // The leaving card is absolutely positioned for exactly as long as it is on
    // screen — held out of the column so the arriving card does not reflow past it.
    const leaving = document.querySelector(".step-exit-l");
    expect(leaving).toBeTruthy();
    expect(leaving?.className).toContain("absolute");
    expect(leaving?.getAttribute("aria-hidden")).toBe("true");
    expect(leaving?.hasAttribute("inert")).toBe(true);
    expect(document.querySelector(".step-enter-r")).toBeTruthy();
    // …and the pair the walk wears is a pair `globals.css` names in its
    // reduced-motion block: there is no third card animation a preference could miss.
    expect(cardMotion()).toEqual(["step-enter-r", "step-exit-l"]);

    // One transition later the copy is gone: a second set of every field in the
    // section is a trap for a screen reader and for any query by label.
    await waitFor(() => expect(document.querySelector(".step-exit-l")).toBeNull());
    expect(document.getElementById("identity")).toBeNull();
  });

  test("going back slides the other way", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Copy"));
    await waitFor(() => expect(document.querySelector(".step-exit-l")).toBeNull());

    await user.click(screen.getByRole("button", { name: messages.stepBack }));
    expect(document.querySelector(".step-exit-r")).toBeTruthy();
    expect(document.querySelector(".step-enter-l")).toBeTruthy();
    await waitFor(() => expect(stepHeading().textContent).toBe("Identity"));
  });

  test("a step that becomes complete rings the Next button once", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");
    // The loaded brief makes the first step complete, so the ring has fired once —
    // the step the visitor is standing on has become one they can leave.
    const opening = document.querySelector(".animate-ready-ring");
    expect(opening).toBeTruthy();

    // Break it, and fix it: a second transition on the same step is a second ring.
    await user.clear(screen.getByLabelText("Target Audience"));
    await user.type(screen.getByLabelText("Target Audience"), "b");
    expect(document.querySelector(".animate-ready-ring")).not.toBe(opening);
    const rung = document.querySelector(".animate-ready-ring");

    // Still complete, several keystrokes later: the ring is a one-shot, keyed on the
    // transitions — so it has not been replayed. The node is the same node.
    await user.type(screen.getByLabelText("Campaign Name"), "xyz");
    expect(document.querySelector(".animate-ready-ring")).toBe(rung);
  });

  test("walking onto a step that was already complete does not ring for it", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");
    await waitFor(() => expect(document.querySelector(".animate-ready-ring")).toBeTruthy());

    // Copy was finished long before the visitor got here: the ring is for a step
    // that became complete, not one that already was.
    await user.click(screen.getByRole("button", { name: messages.stepNext }));
    await waitFor(() => expect(stepHeading().textContent).toBe("Copy"));
    expect(document.querySelector(".animate-ready-ring")).toBeNull();
  });
});

describe("BriefPage — the review step (W8)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
    localStorage.setItem("cf:presentation", "guided");
  });

  // D37: adopting a brief IS arriving at its route — wait for the route's brief to land.
  // D37: adopting a brief IS arriving at its route — wait for the route's brief to
  // land, and for the first step's validation to have settled: the ready ring fires
  // once the loaded brief's first step became complete, and its remount is the
  // exact window in which a click on Next is lost (L2). Waiting here drains that
  // cascade before any test clicks.
  const adopt = async (_user: ReturnType<typeof userEvent.setup>, id: string) => {
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(id));
    await waitFor(() => expect(document.querySelector(".animate-ready-ring")).toBeTruthy());
  };

  const stepHeading = () => screen.getByRole("heading", { level: 1 });
  const segments = () =>
    within(screen.getByRole("navigation", { name: messages.segBarLabel })).getAllByRole("button");
  // The review step is the walk's last, derived from the one list — never a number.
  const reviewIndex = sectionOrder("brief").length;
  const toReview = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(segments()[reviewIndex]);
    await waitFor(() => expect(stepHeading().textContent).toBe("Review"));
  };
  const row = (section: string) => document.querySelector(`[data-review-row="${section}"]`);

  /** A classic brief carrying treatments, output and a style block, so every row can show. */
  const fullEntry = {
    file: "full.yaml",
    revision: "r1",
    brief: {
      ...brief("full"),
      treatments: [{ id: "bold-hero", layout: "headline-top", tone: "bold" }],
      output: { formats: ["static"], platforms: ["linkedin"] },
      style: { fontFamily: "Lora", fontWeight: 700 },
    },
  };

  test("every summary row's Edit reaches its section — the step switches and the section scrolls", async () => {
    const user = userEvent.setup();
    const scroller = vi.fn();
    Element.prototype.scrollIntoView = scroller;
    routes({ list: () => json({ briefs: [fullEntry] }) });
    renderWithRun(<Editor id="full" />);
    await adopt(user, "full");
    await toReview(user);

    // One row per section the projection carries — and the rows speak display
    // names (D18), never the raw ids the brief file spells.
    for (const section of sectionOrder("brief")) {
      expect(row(section)).not.toBeNull();
    }
    const outputRow = row("output") as HTMLElement;
    expect(outputRow.textContent).toContain("Still images");
    expect(outputRow.textContent).toContain("LinkedIn");
    expect(outputRow.textContent).not.toContain("linkedin");
    // Exactly ONE composed preview on screen at Review (D43): the figure's. The count
    // is the assertion — a dock that failed to stay suppressed on Review would make
    // it two, and this test would catch it. The page carries other svg chrome, so the
    // creatives are picked by what they draw: the brief's own headline.
    const headlineCreatives = Array.from(document.querySelectorAll("svg")).filter((el) =>
      el.textContent?.includes("Hi"),
    );
    expect(headlineCreatives).toHaveLength(1);

    // Each Edit hands its section to W6's reveal: the step switches, and the
    // deferred scroll finds the section once it has mounted.
    for (const section of sectionOrder("brief")) {
      const scrollsBefore = scroller.mock.calls.length;
      await user.click(
        screen.getByRole("button", { name: messages.reviewEditLabel(SECTION_TITLES[section]) }),
      );
      await waitFor(() => expect(stepHeading().textContent).toBe(SECTION_TITLES[section]));
      expect(scroller.mock.calls.length).toBeGreaterThan(scrollsBefore);
      // …and back to Review for the next row.
      await user.click(segments()[reviewIndex]);
      await waitFor(() => expect(stepHeading().textContent).toBe("Review"));
    }
  });

  // Corrected for D35: Save carries the refusal now that "Apply to run" is retired.
  test("Save's refusal marks every failing section and reveals the first", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));

    // A blank draft fails Identity, Copy and Products — but nothing is marked yet
    // (D1): the user has been nowhere and has attempted nothing.
    await toReview(user);
    expect(screen.queryByText(messages.briefId)).toBeNull();

    // D3: Save is never disabled — pressing it is how the user asks what is wrong.
    await saveVia(user, "Save");

    // The first failing section is the one revealed…
    await waitFor(() => expect(stepHeading().textContent).toBe("Identity"));
    // (The footer's status sentence speaks the first error too, so scope the
    // "marked" assertions to the sections themselves.)
    expect(within(document.getElementById("identity") as HTMLElement).getByText(messages.briefId)).toBeTruthy();
    // …and every failing section is marked, not only the first: Products' own
    // error is on screen the moment the walk reaches it, untouched.
    await user.click(segments()[sectionOrder("brief").indexOf("products")]);
    await waitFor(() => expect(stepHeading().textContent).toBe("Products"));
    // The argument tracks the classic floor this lane moved (2 → 1) — it is not
    // exported by validate.ts, so the literal restates it. If the floor moves
    // again, this assertion moving with it is the point: it pins the wording.
    expect(within(document.getElementById("products") as HTMLElement).getByText(messages.products(1, "Classic"))).toBeTruthy();
  });

  /**
   * A variation draft failing both Output and Variation Policy is the case that
   * exposes the bucket-order bounce (M1): `validateState`'s key order puts `policy`
   * before `output`, but the walk reaches Output first — so the old first-key
   * bounce landed the user on Policy, a step they would not have walked to yet.
   */
  const brokenOutputAndPolicy = {
    file: "op.yaml",
    revision: "r1",
    brief: {
      ...brief("op"),
      mode: "variation",
      variation: {
        count: 0,
        axes: { layout: ["headline-top"], tone: ["bold"], background: { source: ["procedural"] }, paletteShift: [0] },
      },
      output: { formats: [], platforms: [] },
    },
  };

  test("a refused Save bounces to the first failing step in walk order, not the first error bucket (M1)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [brokenOutputAndPolicy] }) });
    renderWithRun(<Editor id="op" />);
    await adopt(user, "op");
    await toReview(user);

    await saveVia(user, "Save");

    // Output precedes Variation Policy in sectionOrder — the walk's order, which
    // the bounce follows. validateState's key order alone would have chosen Policy.
    await waitFor(() => expect(stepHeading().textContent).toBe("Output"));
    expect(stepHeading().textContent).not.toBe("Variation Policy");
  });

  test("a refused Save speaks its refusal on the step it lands on (D38)", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));
    await toReview(user);

    await saveVia(user, "Save");

    // The bounce lands on Identity — and the refusal sentence is on screen THERE.
    // The status surface used to live only in the Review-step bar, which the same
    // React commit that produced the refusal unmounted: the user landed on a step
    // with no message and no verb anywhere on the page.
    await waitFor(() => expect(stepHeading().textContent).toBe("Identity"));
    const refusal = screen
      .getAllByRole("status")
      .find((el) => el.textContent.startsWith("Not saved yet —"));
    expect(refusal).toBeTruthy();
  });

  test("a refused Save leaves focus on the revealed section, never the body (H2)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [brokenOutputAndPolicy] }) });
    renderWithRun(<Editor id="op" />);
    await adopt(user, "op");
    await toReview(user);

    await saveVia(user, "Save");

    // The pressed verb is unmounted by the bounce, so focus used to drop to
    // document.body — no landing point for a keyboard or screen-reader user. The
    // refusal now hands focus to the revealed section, the same target the
    // outline's activation uses.
    await waitFor(() => expect(stepHeading().textContent).toBe("Output"));
    expect(document.activeElement).toBe(document.getElementById("output"));
  });

  test("Review renders exactly one status surface (D38)", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));

    // Refuse from Review, land on Identity, then walk back to Review with every
    // error now marked — the surface must appear once, not once per placement.
    await toReview(user);
    await saveVia(user, "Save");
    await waitFor(() => expect(stepHeading().textContent).toBe("Identity"));
    await user.click(segments()[sectionOrder("brief").length]);
    await waitFor(() => expect(stepHeading().textContent).toBe("Review"));

    // One StatusLine speaking the refusal…
    const refusals = screen
      .getAllByRole("status")
      .filter((el) => el.textContent.startsWith("Not saved yet —"));
    expect(refusals).toHaveLength(1);
    // …and one ErrorStrip chip per failing section (the footer's own status
    // sentence and the segbar never match these selectors).
    const identityChips = Array.from(document.querySelectorAll("button.rounded-full")).filter((b) =>
      /Identity/.test(b.textContent ?? ""),
    );
    expect(identityChips).toHaveLength(1);
  });

  test("a row whose field the projection omits disappears", async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    routes({ list: () => json({ briefs: [fullEntry] }) });
    const first = renderWithRun(<Editor id="full" />);
    await adopt(user, "full");
    await toReview(user);
    // Treatments are in the projection, so the row is there.
    expect(row("treatments")).not.toBeNull();
    first.unmount();

    // A classic brief without treatments: toBrief omits the field, and its row
    // goes with it — Review shows what will actually be submitted.
    routes({ list: () => json({ briefs: [entry("plain", "r1")] }) });
    renderWithRun(<Editor id="plain" />);
    await adopt(user, "plain");
    await toReview(user);
    expect(row("identity")).not.toBeNull();
    expect(row("treatments")).toBeNull();
  });

  test("the action bar stands on Review in Guided and returns to the foot in Everything", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("ok", "r1")] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // Guided keeps the verbs on the step that performs them — not on Identity.
    expect(screen.queryByTestId("action-bar")).toBeNull();
    await toReview(user);
    expect(screen.getByTestId("action-bar")).toBeTruthy();

    // Everything mounts the same bar back at the foot of the whole stack.
    await user.click(screen.getByRole("button", { name: messages.presentationEverything }));
    await waitFor(() => expect(screen.getByTestId("action-bar")).toBeTruthy());
  });
});

describe("BriefPage — the preview rail (R7)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
    localStorage.setItem("cf:presentation", "guided");
  });

  // D37: adopting a brief IS arriving at its route — and the first step's validation
  // must have settled before the walk is driven (the same gate the guided suite uses).
  const adopt = async (_user: ReturnType<typeof userEvent.setup>, id: string) => {
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(id));
    await waitFor(() => expect(document.querySelector(".animate-ready-ring")).toBeTruthy());
  };

  const stepHeading = () => screen.getByRole("heading", { level: 1 });
  const segments = () =>
    within(screen.getByRole("navigation", { name: messages.segBarLabel })).getAllByRole("button");
  const reviewIndex = sectionOrder("brief").length;
  const preview = () => screen.getByRole("complementary", { name: messages.previewLegend });
  // The rail describe's brief carries an output block, so the caption names a platform.
  const okEntry = {
    file: "ok.yaml",
    revision: "r1",
    brief: { ...brief("ok"), output: { formats: ["static"], platforms: ["linkedin"] } },
  };

  test("the rail mounts beside the column on a guided step, found by its landmark (R7.3)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    // getByRole — never getAllByRole(...)[0] (D48): the landmark is the one named slot.
    const rail = preview();
    // The dock's own words live inside the landmark: the caption names the platform
    // as a display label, and the step readout is the walk's cursor.
    expect(within(rail).getByText("Square · LinkedIn")).toBeTruthy();
    expect(within(rail).getByText(messages.previewStep(1, 7))).toBeTruthy();
    // D44: the rail is a sibling of the walk's card — never a copy inside it, where a
    // step change would render two live copies and the card's transform would trap it.
    expect(screen.getByTestId("step-card").contains(rail)).toBe(false);
  });

  test("the rail is suppressed on Review — exactly one composed preview is on screen (D43)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");
    await user.click(segments()[reviewIndex]);
    await waitFor(() => expect(stepHeading().textContent).toBe("Review"));

    expect(screen.queryByRole("complementary", { name: messages.previewLegend })).toBeNull();
    // The figure owns Review: the brief's headline is drawn by exactly one creative.
    const headlineCreatives = Array.from(document.querySelectorAll("svg")).filter((el) =>
      el.textContent?.includes("Hi"),
    );
    expect(headlineCreatives).toHaveLength(1);
  });

  test("the rail is absent in Everything — Guided only (D43)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    await user.click(screen.getByRole("button", { name: messages.presentationEverything }));
    await waitFor(() => expect(document.getElementById("products")).toBeTruthy());
    expect(screen.queryByRole("complementary", { name: messages.previewLegend })).toBeNull();
  });

  test("a brief with nothing to draw renders no rail (D26, M3)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");
    expect(preview()).toBeTruthy();

    // The zero-product state is reached the way a user reaches it — removing every
    // product on the Products step. (A loaded file without products is seeded with one
    // placeholder, so a product-less brief fixture would never reach the null branch.)
    await user.click(segments()[2]);
    await waitFor(() => expect(stepHeading().textContent).toBe("Products"));
    await user.click(screen.getAllByRole("button", { name: messages.productRemove })[0]);
    await user.click(screen.getAllByRole("button", { name: messages.productRemove })[0]);

    // No product, no preview — the dock never invents a creative to fill the slot.
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: messages.previewLegend })).toBeNull(),
    );
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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("ok"));
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
    const spy = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation((key: string, value: string) => {
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
});

describe("BriefPage — the Layout step (T7)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
    localStorage.setItem("cf:presentation", "guided");
  });

  // D37: adopting a brief IS arriving at its route — and the first step's validation
  // must have settled before the walk is driven (the same gate the guided suite uses).
  const adopt = async (_user: ReturnType<typeof userEvent.setup>, id: string) => {
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(id));
    await waitFor(() => expect(document.querySelector(".animate-ready-ring")).toBeTruthy());
  };

  const stepHeading = () => screen.getByRole("heading", { level: 1 });
  const next = () => screen.getByRole("button", { name: messages.stepNext });
  const back = () => screen.getByRole("button", { name: messages.stepBack });
  const seg = (name: RegExp) =>
    within(screen.getByRole("navigation", { name: messages.segBarLabel })).getByRole("button", { name });
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
        axes: { layout: ["headline-top"], tone: ["bold"], background: { source: ["procedural"] }, paletteShift: [0] },
      },
    },
  };

  test("the classic walk carries the Layout step after Treatments, and Next/Back traverse it", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    await user.click(seg(/: Layout,/));
    await waitFor(() => expect(stepHeading().textContent).toBe("Layout"));
    await user.click(back());
    await waitFor(() => expect(stepHeading().textContent).toBe("Treatments"));
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Layout"));
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Output"));
  });

  test("randomized places the Layout step between Products and Output (T7)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [randEntry] }) });
    renderWithRun(<Editor id="rand" />);
    await adopt(user, "rand");

    await user.click(seg(/: Layout,/));
    await waitFor(() => expect(stepHeading().textContent).toBe("Layout"));
    await user.click(back());
    await waitFor(() => expect(stepHeading().textContent).toBe("Products"));
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Layout"));
    await user.click(next());
    await waitFor(() => expect(stepHeading().textContent).toBe("Output"));
  });

  test("the Sections outline reaches the Layout step (D25/GB-D18)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    const row = await screen.findByRole("button", { name: "Layout" });
    await user.click(row);
    await waitFor(() => expect(stepHeading().textContent).toBe("Layout"));
  });

  test("the rail is suppressed on the Layout step — exactly one composed preview is on screen (D43/D63)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    await user.click(seg(/: Layout,/));
    await waitFor(() => expect(stepHeading().textContent).toBe("Layout"));

    // No rail: the step carries its own frame, and one slot is the whole rule.
    expect(screen.queryByRole("complementary", { name: messages.previewLegend })).toBeNull();
    // Counted, as the rail tests count — the creatives are picked by what they draw.
    const headlineCreatives = Array.from(document.querySelectorAll("svg")).filter((el) =>
      el.textContent?.includes("Hi"),
    );
    expect(headlineCreatives).toHaveLength(1);
  });

  test("a style choice made on the Layout step reaches the brief the save would send (D58)", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [okEntry] }) });
    renderWithRun(<Editor id="ok" />);
    await adopt(user, "ok");

    await user.click(seg(/: Layout,/));
    await waitFor(() => expect(stepHeading().textContent).toBe("Layout"));
    await user.click(screen.getByRole("button", { name: "Lora" }));

    // The projection is on screen in the rail's YAML view — a step the rail serves,
    // since the Layout step itself carries the frame (D43).
    await user.click(seg(/: Output,/));
    const rail = screen.getByRole("complementary", { name: messages.previewLegend });
    await user.click(within(rail).getByRole("button", { name: messages.previewRailYamlView }));
    expect(within(rail).getByText(/fontFamily: Lora/)).toBeTruthy();
  });
});

describe("BriefPage — Generate's three-way question (D35)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("cf:brief-picked", "1");
    localStorage.setItem("cf:presentation", "everything");
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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

    // Edit the loaded brief: the shell still holds camp, the screen holds camp+edit.
    await user.type(screen.getByLabelText("Headline"), " edited");

    await user.click(screen.getByRole("button", { name: "Generate" }));
    const dialog = await screen.findByRole("dialog", { name: messages.generateDraftTitle });
    // Exactly one prompt on this path: the guard's "Unsaved edits" is nowhere.
    expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull();

    await user.click(within(dialog).getByRole("button", { name: new RegExp(`^${messages.generateDraftRunThis}`) }));

    // The ON-SCREEN draft was POSTed — never the shell's previous campaign.
    const generatePost = await waitFor(() => {
      const call = calls.find((c) => c.url.includes("/campaigns/generate"));
      expect(call).toBeTruthy();
      return call!;
    });
    expect((generatePost.body as { campaignMessage?: string }).campaignMessage).toBe("Hi edited");
    // run-without-write: no brief write left the page
    expect(calls.filter((c) => c.method !== "GET" && c.url.includes("/campaigns/briefs"))).toEqual([]);
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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

    await user.type(screen.getByLabelText("Headline"), " edited");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    const dialog = await screen.findByRole("dialog", { name: messages.generateDraftTitle });
    await user.click(within(dialog).getByRole("button", { name: new RegExp(`^${messages.generateDraftSaveRun}`) }));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

    // Differ AND be invalid: edit the headline, then clear it — Copy blocks an empty
    // headline, and the draft still differs from the shell's committed brief.
    // (Campaign Name is readOnly on a loaded brief, so the headline is the field
    // that can carry the invalidity here.)
    await user.type(screen.getByLabelText("Headline"), " edited");
    await user.clear(screen.getByLabelText("Headline"));

    await user.click(screen.getByRole("button", { name: "Generate" }));
    const dialog = await screen.findByRole("dialog", { name: messages.generateDraftTitle });
    await user.click(within(dialog).getByRole("button", { name: new RegExp(`^${messages.generateDraftRunThis}`) }));

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

    await user.type(screen.getByLabelText("Headline"), " edited");
    await user.clear(screen.getByLabelText("Headline"));

    await user.click(screen.getByRole("button", { name: "Generate" }));
    const dialog = await screen.findByRole("dialog", { name: messages.generateDraftTitle });
    await user.click(within(dialog).getByRole("button", { name: new RegExp(`^${messages.generateDraftSaveRun}`) }));

    // The save path's own `refuseInvalid` gates it — nothing is written, nothing
    // runs, and the editor has already bounced to Copy with the refusal on screen;
    // the header carries no gate of its own to disagree with.
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("status")
          .some((el) => el.textContent.startsWith("Not saved yet —")),
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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

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
    localStorage.setItem("cf:presentation", "everything");
  });

  test("/brief/{id} loads that brief, and the shell follows what the URL named", async () => {
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(
      <>
        <RunBriefProbe />
        <Editor id="camp" />
      </>,
    );

    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));
    // setRunBrief follows AFTER the load succeeds, so Generate runs what the URL shows
    await waitFor(() => expect(screen.getByTestId("run-brief").textContent).toBe("camp"));
  });

  test("a reload at the same route reopens the same brief — without cf:brief to lean on", async () => {
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });

    const first = renderWithRun(<Editor id="camp" />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));
    first.unmount();

    // The reload: no shell state to inherit (the record is dropped, not just absent),
    // only the route.
    localStorage.removeItem("cf:brief");
    renderWithRun(<Editor id="camp" />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));
  });

  test("an unknown id is answered with the empty state, names it, and creates no draft", async () => {
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
    expect(screen.getByRole("link", { name: messages.briefNotFoundGrid }).getAttribute("href")).toBe("/grid");
    expect(screen.getByRole("link", { name: messages.briefNotFoundNew }).getAttribute("href")).toBe("/brief/new");
    // No draft was created for the unknown id.
    await new Promise((r) => setTimeout(r, 50));
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
    expect(keys.filter((k) => k.startsWith("cf:draft:"))).toEqual([]);
  });

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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));
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
