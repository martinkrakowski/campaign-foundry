import { describe, test, expect, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun, json } from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
import { fromBrief, saveDraftToStorage } from "@/components/campaign/editor-state";
import BriefPage from "../page";

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
const routes = (handlers: { list?: () => Response; post?: () => Response; put?: (url: string) => Response }) => {
  const calls: { url: string; method: string }[] = [];
  vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
    const u = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url: u, method });
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
    renderWithRun(<BriefPage />);

    await waitFor(() => expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(0));
    const onMount = calls.filter((c) => c.method === "GET").length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(onMount));
  });

  test("a failing list is logged rather than thrown", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    routes({ list: () => json({ error: "boom" }, 500) });
    renderWithRun(<BriefPage />);
    await waitFor(() => expect(error).toHaveBeenCalledWith("Failed to load briefs:", expect.anything()));
    error.mockRestore();
  });

  test("selecting a brief loads it, and saving sends back the revision it was loaded with", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "rev-abc")] }) });
    renderWithRun(<BriefPage />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    await user.click(screen.getByText("New brief..."));
    await user.click(await screen.findByText("camp"));

    // the editor now holds the loaded brief
    await waitFor(() => expect((screen.getByLabelText("Brief ID") as HTMLInputElement).value).toBe("camp"));

    await user.click(screen.getByText("Save & apply"));
    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT");
      expect(put?.url).toContain("revision=rev-abc");
    });
  });

  test("a new draft is saved with a POST", async () => {
    const user = userEvent.setup();
    const calls = routes({});
    renderWithRun(<BriefPage />);
    await waitForEditorReady();

    await fillValidDraft(user);

    await waitFor(() =>
      expect((screen.getByText("Save & apply").closest("button") as HTMLButtonElement).disabled).toBe(false),
    );
    await user.click(screen.getByText("Save & apply"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
  });

  test("a failed save surfaces the message", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }), put: () => json({ error: "conflict" }, 409) });
    renderWithRun(<BriefPage />);

    await user.click(screen.getByText("New brief..."));
    await user.click(await screen.findByText("camp"));
    await waitFor(() => expect((screen.getByLabelText("Brief ID") as HTMLInputElement).value).toBe("camp"));

    await user.click(screen.getByText("Save & apply"));
    expect(await screen.findByText(/conflict/)).toBeTruthy();
  });

  test("Save as... creates a copy under the new id and closes the dialog", async () => {
    const user = userEvent.setup();
    const calls = routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<BriefPage />);
    await fillValidDraft(user);

    await user.click(screen.getByRole("button", { name: "Save as..." }));
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    await waitFor(() => expect(screen.queryByLabelText("New brief id")).toBeNull());
  });

  test("a failed Save as... keeps the dialog open and shows why", async () => {
    const user = userEvent.setup();
    routes({ post: () => json({ error: "already exists" }, 409) });
    renderWithRun(<BriefPage />);
    await fillValidDraft(user);

    await user.click(screen.getByRole("button", { name: "Save as..." }));
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/already exists/)).toBeTruthy();
    expect(screen.getByLabelText("New brief id")).toBeTruthy();
  });

  test("the Save as... dialog can be dismissed", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<BriefPage />);
    await fillValidDraft(user);

    await user.click(screen.getByRole("button", { name: "Save as..." }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New brief id")).toBeNull();
  });

  test("New brief... returns the editor to a blank draft", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });
    renderWithRun(<BriefPage />);

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
    renderWithRun(<BriefPage />);

    expect(screen.getByText("Draft not applied")).toBeTruthy();
    await fillValidDraft(user);
    await user.click(screen.getByText("Apply to run"));
    await waitFor(() => expect(screen.queryByText("Draft not applied")).toBeNull());
  });

  test("Discard throws away the edit", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<BriefPage />);
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
    renderWithRun(<BriefPage />);
    await waitForEditorReady();

    await user.click(screen.getByText("YAML split on"));
    expect(screen.getByText(/"targetRegion"/)).toBeTruthy();
    await user.click(screen.getByText("YAML split off"));
    expect(screen.queryByText(/"targetRegion"/)).toBeNull();
  });

  test("an error chip scrolls to its section", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<BriefPage />);
    await waitForEditorReady();

    // The editor opens on the shell's active brief, which is valid — clear a required
    // field so Identity actually has something to report.
    await user.clear(screen.getByLabelText("Target Region"));

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

  test("an error chip for a section that has no panel is a no-op, not a crash", async () => {
    const user = userEvent.setup();
    // A randomized brief whose policy is invalid raises Policy errors, but E1 renders no
    // policy panel (it arrives in E2.2) — so the chip's scroll target does not exist.
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
    renderWithRun(<BriefPage />);

    await user.click(screen.getByText("New brief..."));
    await user.click(await screen.findByText("rand"));

    const chip = (await screen.findAllByRole("button", { name: /Policy/ })).find((b) =>
      /Policy/.test(b.textContent ?? ""),
    ) as HTMLElement;
    expect(chip).toBeTruthy();
    expect(document.getElementById("policy")).toBeNull();

    await user.click(chip);
    expect(chip).toBeTruthy();
  });

  test("unsaved edits come back when the brief they belong to is reopened", async () => {
    const user = userEvent.setup();
    routes({ list: () => json({ briefs: [entry("camp", "r1")] }) });

    // what the auto-save would have written while editing "camp"
    const edited = fromBrief(brief("camp") as never, { file: "camp.yaml", revision: "r1" });
    saveDraftToStorage({ ...edited, campaignMessage: "unsaved work" });

    renderWithRun(<BriefPage />);
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
    renderWithRun(<BriefPage />);

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
    renderWithRun(<BriefPage />);

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
    renderWithRun(<BriefPage />);

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
      expect(button("Save & apply").disabled).toBe(true);
      expect(button("Save as...").disabled).toBe(true);
    });
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  test("Save as… onto an existing id asks before overwriting, and honours a refusal", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => false);
    const calls = routes({ list: () => json({ briefs: [entry("taken", "r1")] }) });
    renderWithRun(<BriefPage />);
    await waitForEditorReady();

    await user.click(screen.getByRole("button", { name: "Save as..." }));
    await user.type(screen.getByLabelText("New brief id"), "taken");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(globalThis.confirm).toHaveBeenCalled();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  test("accepting the overwrite retries with ?replace=1", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => true);
    const calls = routes({ list: () => json({ briefs: [entry("taken", "r1")] }) });
    renderWithRun(<BriefPage />);
    await waitForEditorReady();

    await user.click(screen.getByRole("button", { name: "Save as..." }));
    await user.type(screen.getByLabelText("New brief id"), "taken");
    await user.click(screen.getByRole("button", { name: "Save" }));

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
    renderWithRun(<BriefPage />);
    await waitForEditorReady();

    await user.click(screen.getByRole("button", { name: "Save as..." }));
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(screen.getByRole("button", { name: "Save" }));

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
    renderWithRun(<BriefPage />);
    await waitForEditorReady();

    await user.click(screen.getByRole("button", { name: "Save as..." }));
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(posts).toBe(1));
    expect(screen.getByLabelText("New brief id")).toBeTruthy();
  });

  test("a non-409 Save as… failure is reported", async () => {
    const user = userEvent.setup();
    globalThis.confirm = vi.fn(() => true);
    routes({ post: () => json({ error: "disk full" }, 500) });
    renderWithRun(<BriefPage />);
    await waitForEditorReady();

    await user.click(screen.getByRole("button", { name: "Save as..." }));
    await user.type(screen.getByLabelText("New brief id"), "copy");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/disk full/)).toBeTruthy();
  });

  test("the active brief is re-attached to its file when the listing knows it", async () => {
    const calls = routes({ list: () => json({ briefs: [entry("summer-hydration-2026", "rev-live")] }) });
    renderWithRun(<BriefPage />);

    // the shell's active brief appears in the listing, so the editor adopts that entry's
    // file identity and can save conditionally rather than as a new draft
    await waitFor(() => expect(screen.getByLabelText("Brief ID").hasAttribute("readonly")).toBe(true));

    const user = userEvent.setup();
    await user.click(screen.getByText("Save & apply"));
    await waitFor(() => expect(calls.find((c) => c.method === "PUT")?.url).toContain("revision=rev-live"));
  });

  test("the mode toggle switches between classic and randomized", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<BriefPage />);

    // the section heading, not the inner "Treatments (n)" counter
    const sectionHeading = () => screen.queryByRole("heading", { name: /4 · Treatments/ });
    expect(sectionHeading()).toBeTruthy();
    await user.click(screen.getByText("Randomized"));
    await waitFor(() => expect(sectionHeading()).toBeNull());
    await user.click(screen.getByText("Classic"));
    await waitFor(() => expect(sectionHeading()).toBeTruthy());
  });
});
