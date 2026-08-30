import { describe, test, expect, beforeEach, vi } from "vitest";
import * as messages from "@/components/campaign/messages";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun, json, nextMock } from "@/__tests__/helpers";
import { API, useRun } from "@/lib/run-context";
import { fromBrief, saveDraftToStorage } from "@/components/campaign/editor-state";
import BriefPage from "../page";
import NewBriefPage from "../new/page";

/**
 * The page as a user meets it. `renderWithRun` supplies the outlet that stands in for
 * the sidebar, so the panels the page publishes are placed exactly once — placing them
 * here as well would make every published control exist twice.
 */
const Editor = () => (
  <>
    <BriefPage />
  </>
);

/** `/brief/new` — the same editor, started empty. */
const NewEditor = () => <NewBriefPage />;

/**
 * The blank route with a way to make the shell hand it a campaign *after* it has
 * settled — what the picker does when it is used from another view.
 */
const NewEditorWithPicker = () => {
  const { setBrief } = useRun();
  return (
    <>
      <button type="button" onClick={() => setBrief(brief("camp") as never)}>
        shell picks camp
      </button>
      <NewBriefPage />
    </>
  );
};

/** Save actions live behind the "Save" menu now: open it, then pick the item. */
const saveVia = async (user: ReturnType<typeof userEvent.setup>, item: "Save & apply" | "Save as") => {
  await user.click(screen.getByRole("button", { name: /^Save$/ }));
  await user.click(await screen.findByRole("menuitem", { name: new RegExp(item.replace("&", "&")) }));
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

/** Route each call by URL+method; unmatched calls fail loudly rather than hanging. */
const routes = (handlers: {
  list?: () => Response;
  post?: () => Response;
  put?: (url: string) => Response;
  capabilities?: () => Response;
}) => {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = init?.body;
    calls.push({
      url: u,
      method,
      ...(typeof raw === "string" ? { body: JSON.parse(raw) as Record<string, unknown> } : {}),
    });
    if (method === "GET" && u === `${API}/campaigns/capabilities`) {
      return Promise.resolve(handlers.capabilities?.() ?? json({ motion: true }));
    }
    if (method === "GET" && u.startsWith(`${API}/campaigns/briefs`)) {
      return Promise.resolve(handlers.list?.() ?? json({ briefs: [] }));
    }
    if (method === "POST") return Promise.resolve(handlers.post?.() ?? json({ file: "x.yaml", brief: brief("x") }, 201));
    if (method === "PUT") return Promise.resolve(handlers.put?.(u) ?? json({ file: "x.yaml", brief: brief("x") }));
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

/** The editor adopts the shell's active brief only after the listing arrives. */
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
    globalThis.confirm = vi.fn(() => true);
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

  test("selecting a brief loads it, and saving sends back the revision it was loaded with", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "rev-abc")] }) });
    renderWithRun(<Editor />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    await user.click(screen.getByText("New brief..."));
    await user.click(await screen.findByText("camp"));

    // the editor now holds the loaded brief
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

    await saveVia(user, "Save & apply");
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
    await saveVia(user, "Save & apply");

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
    renderWithRun(<Editor />);

    await user.click(screen.getByText("New brief..."));
    await user.click(await screen.findByText("camp"));
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

    await saveVia(user, "Save & apply");
    expect(await screen.findByText(/conflict/)).toBeTruthy();
  });

  test("Save as... creates a copy under the new id and closes the dialog", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor />);
    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    await waitFor(() => expect(screen.queryByLabelText("New brief id")).toBeNull());
  });

  test("a failed Save as... keeps the dialog open and shows why", async () => {
    const user = userEvent.setup();
    routes({ post: () => json({ error: "already exists" }, 409) });
    renderWithRun(<Editor />);
    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/already exists/)).toBeTruthy();
    expect(screen.getByLabelText("New brief id")).toBeTruthy();
  });

  test("the Save as... dialog can be dismissed", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<Editor />);
    await fillValidDraft(user);

    await saveVia(user, "Save as");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New brief id")).toBeNull();
  });

  test("New brief... asks for the blank route rather than emptying the form in place", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor />);

    await user.click(screen.getByText("New brief..."));
    await user.click(await screen.findByText("camp"));
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe("camp"));

    // reopen and choose the create-new row
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

  test("choosing a campaign while on the blank route takes you to it", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<NewEditorWithPicker />);
    // let the listing land: from here the adopt-the-active-brief effect is armed
    await waitFor(() => expect(screen.getByText("Randomized")).toBeTruthy());

    await user.click(screen.getByRole("button", { name: "shell picks camp" }));

    // There is a campaign again, so this page has stopped describing a new brief. It
    // must not keep the choice and show an empty form, and it must not throw the choice
    // away either — both of which this route managed at different points.
    await waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/brief"));
    expect(JSON.parse(localStorage.getItem("cf:brief") ?? "null")?.id).toBe("camp");
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
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));
    expect((screen.getByLabelText("Target Region") as HTMLInputElement).value).toBe("");
    expect(nextMock().router.push.mock.calls.length).toBe(pushesBefore);
  });

  test("declining the prompt keeps what was typed on the blank route", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => false);
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));
    await fillValidDraft(user, "typed");

    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(screen.getAllByText("New brief...").slice(-1)[0]);

    expect(globalThis.confirm).toHaveBeenCalled();
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

    await waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/brief"));
  });

  test("Save as... keeps the copy's revision, so the next save still guards the write", async () => {
    const user = userEvent.setup();
    const calls = routes({
      list: () => json({ briefs: [entry("camp", "r1")] }),
      post: () => json({ file: "copy.yaml", brief: brief("copy"), revision: "rev-copy" }, 201),
    });
    renderWithRun(<Editor />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );
    await waitFor(() => expect(screen.queryByLabelText("New brief id")).toBeNull());

    // saving the copy must send the revision the POST handed back; without it the write
    // silently drops to last-write-wins, the trap `loadBrief` carries the revision to avoid
    await saveVia(user, "Save & apply");
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.url.includes("revision=rev-copy"))).toBe(true),
    );
  });

  test("Apply on the blank route keeps the brief it just applied", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<NewEditor />);
    await waitFor(() => expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(""));
    await fillValidDraft(user, "fresh");

    await user.click(screen.getByText("Apply to run").closest("button") as HTMLButtonElement);

    // the release must not fire again on the brief this page just created: applying is
    // how a campaign becomes the active one, and clearing it here leaves Generate with
    // nothing to run
    await waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/brief"));
    expect(JSON.parse(localStorage.getItem("cf:brief") ?? "null")?.id).toBe("fresh");
  });

  test("arriving on the blank route lets go of the campaign being left", async () => {
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    // the shell is on `camp`, with unsaved edits to it in storage
    localStorage.setItem("cf:brief", JSON.stringify(brief("camp")));
    saveDraftToStorage(fromBrief(brief("camp"), { file: "camp.yaml" }));

    renderWithRun(<NewEditor />);

    // the shell no longer claims camp is the campaign being worked on, so the selector
    // cannot advertise it and Generate cannot run it
    await waitFor(() => expect(localStorage.getItem("cf:brief")).toBeNull());
    // …but camp's unsaved work is untouched. Getting here does not always follow the
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
    await saveVia(user, "Save & apply");

    // otherwise a reload would blank the brief that was just saved
    await waitFor(() => expect(nextMock().router.replace).toHaveBeenCalledWith("/brief"));
  });

  test("Apply to run moves the status chip off the unapplied state", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<Editor />);

    expect(screen.getByText("Draft not applied")).toBeTruthy();
    await fillValidDraft(user);
    await user.click(screen.getByText("Apply to run"));
    await waitFor(() => expect(screen.queryByText("Draft not applied")).toBeNull());
  });

  test("Discard throws away the edit", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<Editor />);
    await waitForEditorReady();

    const before = (screen.getByLabelText("Headline") as HTMLInputElement).value;
    await user.type(screen.getByLabelText("Headline"), " edited");
    expect((screen.getByLabelText("Headline") as HTMLInputElement).value).not.toBe(before);

    // Discard resets to a blank draft. The run-context sync does not pull the active
    // brief back in — its dependencies have not changed — so the editor stays empty
    // until the user picks something.
    await user.click(screen.getByText("Discard"));
    await waitFor(() =>
      expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe(""),
    );
  });

  test("the YAML split shows the serialized brief and hides the contents list", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<Editor />);
    await waitForEditorReady();

    await user.click(screen.getByText("YAML split on"));
    expect(screen.getByText(/"targetRegion"/)).toBeTruthy();
    await user.click(screen.getByText("YAML split off"));
    expect(screen.queryByText(/"targetRegion"/)).toBeNull();
  });

  test("touching the same field twice does not churn the touched set", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<Editor />);
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
    routes({});
    renderWithRun(<Editor />);
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
    renderWithRun(<Editor />);

    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(await screen.findByText("rand"));

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
    renderWithRun(<Editor />);

    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(await screen.findByText("clip"));

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
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });

    // what the auto-save would have written while editing "camp"
    const edited = fromBrief(brief("camp") as never, { file: "camp.yaml", revision: "r1" });
    saveDraftToStorage({ ...edited, campaignMessage: "unsaved work" });

    renderWithRun(<Editor />);
    await user.click(screen.getAllByText(/^(New brief\.\.\.|summer-hydration-2026)$/)[0]);
    await user.click(await screen.findByText("camp"));

    await waitFor(() =>
      expect((screen.getByLabelText("Headline") as HTMLInputElement).value).toBe("unsaved work"),
    );
  });

  test("declining the prompt keeps the current draft when selecting another brief", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => false);
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor />);

    await user.type(screen.getByLabelText("Headline"), "!");
    const before = (screen.getByLabelText("Campaign Name") as HTMLInputElement).value;

    await user.click(screen.getAllByText(/^(New brief\.\.\.|summer-hydration-2026)$/)[0]);
    await user.click(await screen.findByText("camp"));

    expect(globalThis.confirm).toHaveBeenCalled();
    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(before);
  });

  test("declining the prompt keeps the current draft when starting a new brief", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor />);

    await user.type(screen.getByLabelText("Headline"), "!");
    const before = (screen.getByLabelText("Campaign Name") as HTMLInputElement).value;

    await user.click(screen.getAllByText(/^(New brief\.\.\.|summer-hydration-2026)$/)[0]);
    await user.click(screen.getAllByText("New brief...").slice(-1)[0]);

    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(dialog).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));

    expect((screen.getByLabelText("Campaign Name") as HTMLInputElement).value).toBe(before);
  });

  test("Apply, Save and Save as… all refuse an invalid draft", async () => {
    const user = userEvent.setup();
    const calls = routes({});
    renderWithRun(<Editor />);

    // Wait for the editor to adopt the active brief first: clearing a field the sync is
    // about to repopulate leaves the draft valid again and the buttons enabled.
    await waitForEditorReady();
    await user.clear(screen.getByLabelText("Target Region"));

    // D3: the verbs stay pressable — a dead button cannot explain itself. Pressing one
    // is how the user asks what is wrong, so each refuses out loud instead: nothing is
    // written, and the errors that were hidden until now become visible.
    // Re-query inside the assertion — React replaces these nodes on re-render, so a
    // reference captured beforehand can be stale by the time the draft turns invalid.
    const button = (label: string) =>
      screen.getByText(label).closest("button") as HTMLButtonElement;
    await waitFor(() => expect(screen.getByText("Apply to run").closest("button")).toBeTruthy());
    expect(button("Apply to run").disabled).toBe(false);
    expect(button("Save").disabled).toBe(false);

    await user.click(button("Apply to run"));
    // "Save" opens the menu; the verb the user actually presses is inside it.
    await saveVia(user, "Save & apply");
    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "elsewhere");
    await user.click(
      within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }),
    );

    // all three refused: no write left the page, and the refusal is on screen
    expect(writes(calls)).toEqual([]);
    expect(screen.getByText(messages.targetRegion)).toBeTruthy();
  });

  test("Save as… onto an existing id asks before overwriting, and honours a refusal", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => false);
    const calls = routes({ list: () => json({ briefs: [entry("taken", "r1")] }) });
    renderWithRun(<Editor />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "taken");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

    expect(globalThis.confirm).toHaveBeenCalled();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("accepting the overwrite retries with ?replace=1", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => true);
    const calls = routes({ list: () => json({ briefs: [entry("taken", "r1")] }) });
    renderWithRun(<Editor />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "taken");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.url).toContain("replace=1"));
  });

  test("a 409 from a brief that appeared since the list was fetched offers the same overwrite", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => true);
    let posts = 0;
    const calls = routes({
      post: () => {
        posts += 1;
        return posts === 1 ? json({ error: "already exists" }, 409) : json({ file: "copy.yaml", brief: brief("copy") }, 201);
      },
    });
    renderWithRun(<Editor />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(posts).toBe(2));
    expect(calls.filter((c) => c.method === "POST")[1].url).toContain("replace=1");
  });

  test("refusing the 409 overwrite leaves the copy unwritten", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => false);
    let posts = 0;
    routes({
      post: () => {
        posts += 1;
        return json({ error: "already exists" }, 409);
      },
    });
    renderWithRun(<Editor />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(posts).toBe(1));
    expect(screen.getByLabelText("New brief id")).toBeTruthy();
  });

  test("a non-409 Save as… failure is reported", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => true);
    routes({ post: () => json({ error: "disk full" }, 500) });
    renderWithRun(<Editor />);
    await waitForEditorReady();

    await saveVia(user, "Save as");
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(within(screen.getByRole("dialog", { name: /Save as/ })).getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/disk full/)).toBeTruthy();
  });

  test("the active brief is re-attached to its file when the listing knows it", async () => {
    const calls = routes({ list: () => json({ briefs: [entry("summer-hydration-2026", "rev-live")] }) });
    renderWithRun(<Editor />);

    // the shell's active brief appears in the listing, so the editor adopts that entry's
    // file identity and can save conditionally rather than as a new draft
    await waitFor(() => expect(screen.getByLabelText("Campaign Name").hasAttribute("readonly")).toBe(true));

    const user = userEvent.setup();
    await saveVia(user, "Save & apply");
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
    renderWithRun(<Editor />);

    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(await screen.findByText("rand"));
    await waitFor(() => expect(document.querySelector('[data-section="policy"], #policy')).toBeTruthy());

    // the drawer is only reachable from the Copy section, and only for a randomized brief
    expect(screen.queryByText("Headline Pool")).toBeNull();
    await user.click(screen.getByText("Manage Headline Pool"));
    expect(await screen.findByText("Headline Pool")).toBeTruthy();

    await user.click(screen.getByText("Close"));
    await waitFor(() => expect(screen.queryByText("Headline Pool")).toBeNull());
  });

  test("the view flows and the shell scrolls it, like every other view; the bar sticks inside that", async () => {
    routes({});
    const { container } = renderWithRun(<Editor />);
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

  test("the YAML split panel pins beside the form and scrolls on its own", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<Editor />);
    await waitForEditorReady();
    await user.click(screen.getByText("YAML split on"));
    const pre = screen.getByText(/"targetRegion"/);
    const panel = pre.closest(".sticky") as HTMLElement;
    expect(panel).toBeTruthy();
    expect(panel.className).toMatch(/overflow-y-auto/);
  });

  test("the policy accordion counts its issues, singular and plural", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<Editor />);
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
    routes({});
    renderWithRun(<Editor />);
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
    globalThis.confirm = vi.fn(() => true);
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
      capabilities: () => {
        calls += 1;
        return json({ motion: false, reason: "not probed" });
      },
    });
    renderWithRun(<Editor />);

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

  test("Save & apply carries the same refusal notice that Apply does", async () => {
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
    });
    renderWithRun(<Editor />);

    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(await screen.findByText("clip"));
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
    await saveVia(user, "Save & apply");

    // the Output section already shows this as a field error; the notice is the
    // separate status the action bar owes after applying
    const notice = await screen.findByRole("status");
    expect(notice.textContent).toBe(messages.statusApplyRefusal);
  });

  test("the capabilities are refetched when the window regains focus", async () => {
    const user = userEvent.setup();
    let calls = 0;
    routes({
      capabilities: () => {
        calls += 1;
        return calls === 1 ? json({ motion: true }) : json({ motion: false, reason: "no ffmpeg" });
      },
    });
    renderWithRun(<Editor />);

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

    await saveVia(user, "Save & apply");
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
    await saveVia(user, "Save & apply");
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
    });
    renderWithRun(<Editor />);

    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(await screen.findByText("clip"));
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
    await saveVia(user, "Save & apply");
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

    // Apply is not blocked by the capability, and it reports the refusal
    await user.click(screen.getByText("Apply to run"));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(messages.statusApplyRefusal));
  });

  test("an incompatible format/platform pair is reported in the editor, not only by the API", async () => {
    const user = userEvent.setup();
    // static-only formats with a motion platform declared: the API would refuse at
    // parse time; the editor must say it first.
    const mismatched = {
      file: "odd.yaml",
      revision: "r1",
      brief: { ...brief("odd"), output: { formats: ["static"], platforms: ["instagram-reel"] } },
    };
    routes({ list: () => json({ briefs: [mismatched] }) });
    renderWithRun(<Editor />);

    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(await screen.findByText("odd"));
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
    renderWithRun(<Editor />);
    const row = await screen.findByRole("button", { name: /Identity/ });
    await user.click(row);
    expect(scrollIntoView).toHaveBeenCalled();
    const section = document.querySelector('#identity, [data-section="identity"]') as HTMLElement | null;
    expect(section).not.toBeNull();
    expect(document.activeElement).toBe(section);
  });


  test("an outline row whose section has left the page does nothing", async () => {
    const user = userEvent.setup();
    Element.prototype.scrollIntoView = vi.fn();
    renderWithRun(<Editor />);
    const row = await screen.findByRole("button", { name: /Identity/ });
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
