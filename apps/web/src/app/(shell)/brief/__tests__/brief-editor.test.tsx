import { describe, test, expect, beforeEach, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun, json } from "@/__tests__/helpers";
import { API } from "@/lib/run-context";
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

    await user.type(screen.getByLabelText("Brief ID"), "fresh");
    await user.type(screen.getByLabelText("Target Region"), "DE");
    await user.type(screen.getByLabelText("Target Audience"), "a");
    await user.type(screen.getByLabelText("Campaign Message"), "Hi");
    const names = screen.getAllByLabelText("Name");
    await user.type(names[0], "A");
    await user.type(names[1], "B");
    // the "Logo Path" label wraps the text field, the hidden file input AND the
    // Upload button, so narrow to the text fields before indexing by product
    const logos = screen
      .getAllByLabelText("Logo Path")
      .filter((el) => el.tagName === "INPUT" && el.getAttribute("type") !== "file");
    await user.type(logos[0], "a.png");
    await user.type(logos[1], "b.png");

    const save = screen.getByText("Save & apply").closest("button") as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    await user.click(save);
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
    await user.click(screen.getByText("Apply to run"));
    await waitFor(() => expect(screen.queryByText("Draft not applied")).toBeNull());
  });

  test("Discard clears an edited draft", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<BriefPage />);

    await user.type(screen.getByLabelText("Brief ID"), "temp");
    await user.click(screen.getByText("Discard"));
    await waitFor(() => expect((screen.getByLabelText("Brief ID") as HTMLInputElement).value).toBe(""));
  });

  test("the YAML split shows the serialized brief and hides the contents list", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<BriefPage />);

    await user.click(screen.getByText("YAML split on"));
    expect(screen.getByText(/"targetRegion"/)).toBeTruthy();
    await user.click(screen.getByText("YAML split off"));
    expect(screen.queryByText(/"targetRegion"/)).toBeNull();
  });

  test("an error chip scrolls to its section", async () => {
    const user = userEvent.setup();
    routes({});
    renderWithRun(<BriefPage />);

    // a blank draft fails identity, so the strip is present
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
    routes({});
    renderWithRun(<BriefPage />);

    // Requesting the motion format raises motion errors, but the editor renders no
    // "motion" panel — so the chip's scroll target does not exist.
    await user.click(screen.getByRole("button", { name: "motion" }));
    const chip = (await screen.findAllByRole("button", { name: /Motion/ })).find((b) =>
      /Motion\s*\d/.test(b.textContent ?? ""),
    ) as HTMLElement;
    expect(chip).toBeTruthy();
    expect(document.getElementById("motion")).toBeNull();

    await user.click(chip);
    expect(chip).toBeTruthy();
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
