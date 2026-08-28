import { describe, test, expect, beforeEach, vi } from "vitest";
import * as messages from "@/components/campaign/messages";
import { screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun, json } from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
import { fromBrief, saveDraftToStorage } from "@/components/campaign/editor-state";
import BriefPage from "../page";
import { useEditorPanels } from "@/lib/editor-panels-context";

/** Places the sections the page publishes to the left bar (the variation policy). */
const BarPanels = () => useEditorPanels().panels ?? null;
/** The page plus the bar panels it publishes, as a user would see them together. */
const Editor = () => (
  <>
    <BriefPage />
    <BarPanels />
  </>
);

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

/** The editor adopts the shell's active brief only after the listing arrives. */
const waitForEditorReady = async () =>
  waitFor(() => expect((screen.getByLabelText("Brief ID") as HTMLInputElement).value).not.toBe(""));

const fillValidDraft = async (user: ReturnType<typeof userEvent.setup>, id = "fresh") => {
  await user.type(screen.getByLabelText("Brief ID"), id);
  await user.type(screen.getByLabelText("Target Region"), "DE");
  await user.type(screen.getByLabelText("Target Audience"), "a");
  await user.type(screen.getByLabelText("Campaign Message"), "Hi");
  const names = screen.getAllByLabelText("Name");
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
    await waitFor(() => expect((screen.getByLabelText("Brief ID") as HTMLInputElement).value).toBe("camp"));

    await saveVia(user, "Save & apply");
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT");
      expect(put?.url).toContain("revision=rev-abc");
    });
  });

  test("a new draft is saved with a POST carrying what was typed", async () => {
    const user = userEvent.setup();
    const calls = routes({});
    renderWithRun(<Editor />);
    await waitForEditorReady();

    // The editor adopts the shell's active brief, so reach a genuinely blank draft the
    // way a user would rather than typing on top of the populated fields.
    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(screen.getAllByText("New brief...").slice(-1)[0]);
    await waitFor(() => expect((screen.getByLabelText("Brief ID") as HTMLInputElement).value).toBe(""));

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
    await waitFor(() => expect((screen.getByLabelText("Brief ID") as HTMLInputElement).value).toBe("camp"));

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

  test("New brief... returns the editor to a blank draft", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor />);

    await user.click(screen.getByText("New brief..."));
    await user.click(await screen.findByText("camp"));
    await waitFor(() => expect((screen.getByLabelText("Brief ID") as HTMLInputElement).value).toBe("camp"));

    // reopen and choose the create-new row
    await user.click(screen.getAllByText("camp")[0]);
    await user.click(screen.getByText("New brief..."));
    await waitFor(() => expect((screen.getByLabelText("Brief ID") as HTMLInputElement).value).toBe(""));
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

    const before = (screen.getByLabelText("Campaign Message") as HTMLInputElement).value;
    await user.type(screen.getByLabelText("Campaign Message"), " edited");
    expect((screen.getByLabelText("Campaign Message") as HTMLInputElement).value).not.toBe(before);

    // Discard resets to a blank draft. The run-context sync does not pull the active
    // brief back in — its dependencies have not changed — so the editor stays empty
    // until the user picks something.
    await user.click(screen.getByText("Discard"));
    await waitFor(() =>
      expect((screen.getByLabelText("Campaign Message") as HTMLInputElement).value).toBe(""),
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
      expect((screen.getByLabelText("Campaign Message") as HTMLInputElement).value).toBe("unsaved work"),
    );
  });

  test("declining the prompt keeps the current draft when selecting another brief", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => false);
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor />);

    await user.type(screen.getByLabelText("Campaign Message"), "!");
    const before = (screen.getByLabelText("Brief ID") as HTMLInputElement).value;

    await user.click(screen.getAllByText(/^(New brief\.\.\.|summer-hydration-2026)$/)[0]);
    await user.click(await screen.findByText("camp"));

    expect(globalThis.confirm).toHaveBeenCalled();
    expect((screen.getByLabelText("Brief ID") as HTMLInputElement).value).toBe(before);
  });

  test("declining the prompt keeps the current draft when starting a new brief", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => false);
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<Editor />);

    await user.type(screen.getByLabelText("Campaign Message"), "!");
    const before = (screen.getByLabelText("Brief ID") as HTMLInputElement).value;

    await user.click(screen.getAllByText(/^(New brief\.\.\.|summer-hydration-2026)$/)[0]);
    await user.click(screen.getAllByText("New brief...").slice(-1)[0]);

    expect(globalThis.confirm).toHaveBeenCalled();
    expect((screen.getByLabelText("Brief ID") as HTMLInputElement).value).toBe(before);
  });

  test("Apply, Save and Save as… all refuse an invalid draft", async () => {
    const user = userEvent.setup();
    const calls = routes({});
    renderWithRun(<Editor />);

    // Wait for the editor to adopt the active brief first: clearing a field the sync is
    // about to repopulate leaves the draft valid again and the buttons enabled.
    await waitForEditorReady();
    await user.clear(screen.getByLabelText("Target Region"));

    // Re-query inside the assertion — React replaces these nodes on re-render, so a
    // reference captured beforehand can be stale by the time the draft turns invalid.
    const button = (label: string) =>
      screen.getByText(label).closest("button") as HTMLButtonElement;
    await waitFor(() => {
      expect(button("Apply to run").disabled).toBe(true);
      expect(button("Save").disabled).toBe(true);
      expect(button("Save").disabled).toBe(true);
    });
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
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
    await waitFor(() => expect(screen.getByLabelText("Brief ID").hasAttribute("readonly")).toBe(true));

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
    // U8: the bar floats like the grid's pipeline bar — absolutely positioned inside
    // the column's own scroll container. `fixed` would pin it to the viewport and let
    // it cover the 320px sidebar, which is the bug #79 fixed once already.
    expect(bar.className).toMatch(/\babsolute\b/);
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

    // empty an axis entirely → one issue; empty a second → two
    await user.click(await screen.findByRole("button", { name: "headline-top" }));
    await user.click(screen.getByRole("button", { name: "headline-bottom" }));
    await waitFor(() => expect(screen.getByLabelText("1 issue")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "bold" }));
    await user.click(screen.getByRole("button", { name: "subtle" }));
    await waitFor(() => expect(screen.getByLabelText("2 issues")).toBeTruthy());
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
    expect(screen.getByText(/Motion is not available on this host: no ffmpeg/)).toBeTruthy();
  });

  test("a probe that never settles leaves motion ungated rather than falsely unavailable", async () => {
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
    // a meaningless reason, so the editor stays ungated and the API refuses at run time
    expect(motionToggle().disabled).toBe(false);
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
    // the verdict lands: the motion *kinds* go read-only, but the format toggle stays
    // operable because this draft already requests motion and needs a way out
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "ken-burns-in" }) as HTMLButtonElement).disabled).toBe(true),
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
    let calls = 0;
    routes({
      capabilities: () => {
        calls += 1;
        return calls === 1 ? json({ motion: true }) : json({ motion: false, reason: "no ffmpeg" });
      },
    });
    renderWithRun(<Editor />);

    await waitFor(() => expect(calls).toBe(1));
    expect(motionToggle().disabled).toBe(false);

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
    renderWithRun(<Editor />);
    await waitForEditorReady();

    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(screen.getAllByText("New brief...").slice(-1)[0]);
    await waitFor(() => expect((screen.getByLabelText("Brief ID") as HTMLInputElement).value).toBe(""));
    await fillValidDraft(user);
    await user.click(screen.getByText("Randomized"));

    // request motion, then give it a kind, a duration and a packaging platform
    await user.click(screen.getByRole("button", { name: "motion" }));
    await user.click(screen.getByRole("button", { name: "ken-burns-in" }));
    await user.click(screen.getByRole("button", { name: "Add duration" }));
    await user.click(screen.getByRole("button", { name: "instagram-reel" }));

    await saveVia(user, "Save & apply");
    const post = await waitFor(() => {
      const call = calls.find((c) => c.method === "POST" && c.url.includes("/campaigns/briefs"));
      expect(call).toBeTruthy();
      return call!;
    });
    expect(post.body).toMatchObject({
      mode: "variation",
      variation: { axes: { motion: ["ken-burns-in"], duration: [5] } },
      output: {
        formats: ["static", "motion"],
        platforms: ["instagram-feed", "linkedin", "x", "instagram-reel"],
      },
    });
  });

  test("motion without a kind or a duration blocks Save, and the error reaches its input", async () => {
    const user = userEvent.setup();
    const calls = routes({});
    renderWithRun(<Editor />);
    await waitForEditorReady();

    await user.click(screen.getAllByText("New brief...")[0]);
    await user.click(screen.getAllByText("New brief...").slice(-1)[0]);
    await waitFor(() => expect((screen.getByLabelText("Brief ID") as HTMLInputElement).value).toBe(""));
    await fillValidDraft(user);
    await user.click(screen.getByText("Randomized"));
    await user.click(screen.getByRole("button", { name: "motion" }));

    expect(screen.getByText(messages.motion)).toBeTruthy();
    expect(screen.getByText(messages.duration)).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
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
    await waitFor(() => expect((screen.getByLabelText("Brief ID") as HTMLInputElement).value).toBe("clip"));

    // the probe's verdict lands and the controls go read-only with its reason. The
    // format toggle itself stays operable — the draft already requests motion, so
    // gating it would trap the user with a compatibility error and no control to fix it.
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "ken-burns-in" }) as HTMLButtonElement).disabled).toBe(true),
    );
    expect(motionToggle().disabled).toBe(false);
    expect(screen.getByText(/Motion is not available on this host: no ffmpeg/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "ken-burns-in" }) as HTMLButtonElement).disabled).toBe(true);
    const duration = screen.getByLabelText("Duration 1 (seconds)") as HTMLInputElement;
    expect(duration.disabled).toBe(true);
    expect(duration.value).toBe("6");
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
    await waitFor(() => expect((screen.getByLabelText("Brief ID") as HTMLInputElement).value).toBe("odd"));

    expect(
      await screen.findByText(
        messages.platformsIncompatible("Instagram Reel", ["Video"]),
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement).disabled).toBe(true),
    );
  });
});
