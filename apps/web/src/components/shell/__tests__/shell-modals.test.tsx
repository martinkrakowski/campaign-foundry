import { describe, test, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun, exerciseFocusTrap } from "@/__tests__/helpers";
import { ModelSelector } from "../ModelSelector";
import { BriefPicker } from "../BriefPicker";
import { TelemetryDrawer } from "../TelemetryDrawer";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  localStorage.setItem("cf:brief-picked", "1"); // suppress auto-open unless a test wants it
});

describe("ModelSelector", () => {
  test("shows the active model and switches it", async () => {
    const user = userEvent.setup();
    renderWithRun(<ModelSelector />);
    expect(screen.getByText("Auto")).toBeTruthy();
    await user.click(screen.getByTitle("Change image model"));
    const dialog = await screen.findByRole("dialog", { name: "Select image model" });
    await user.click(within(dialog).getByText("Procedural (offline)"));
    expect(screen.getByText("Procedural (offline)")).toBeTruthy();
  });

  test("closes the picker on Escape", async () => {
    const user = userEvent.setup();
    renderWithRun(<ModelSelector />);
    await user.click(screen.getByTitle("Change image model"));
    const dialog = await screen.findByRole("dialog", { name: "Select image model" });
    exerciseFocusTrap(dialog);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Select image model" })).toBeNull());
  });

  test("flags a reuse brief that may skip the model", async () => {
    localStorage.setItem(
      "cf:brief",
      JSON.stringify({ id: "reuse", targetRegion: "DE", targetAudience: "a", campaignMessage: "Hi", products: [{ id: "p", name: "P", primaryColor: "#111111", logoPath: "l.png", inputAsset: "assets/x.png" }] }),
    );
    renderWithRun(<ModelSelector />);
    expect(await screen.findByText(/reuse brief/)).toBeTruthy();
  });
});

describe("BriefPicker", () => {
  beforeEach(() => localStorage.removeItem("cf:brief-picked")); // let it auto-open

  const routeBriefs = (body: unknown, ok = true) =>
    vi.mocked(globalThis.fetch).mockImplementation((url) =>
      Promise.resolve(String(url).includes("/campaigns/briefs") ? json(body, ok ? 200 : 500) : json({ halted: false, assets: [], log: null })),
    );

  test("lists briefs, marks the current one, and selecting one loads it", async () => {
    const user = userEvent.setup();
    routeBriefs({
      briefs: [
        { file: "current.yaml", brief: { id: "summer-hydration-2026", targetRegion: "DE", products: [{ id: "a" }] } },
        { file: "demo.yaml", brief: { id: "demo", targetRegion: "DE", products: [{ id: "a" }, { id: "b" }], treatments: [{ id: "t1" }, { id: "t2" }] } },
      ],
    });
    renderWithRun(<BriefPicker />);
    await screen.findByText("current.yaml");
    expect(screen.getByText("current")).toBeTruthy(); // badge on the active brief
    expect(screen.getByText(/1 product /)).toBeTruthy(); // singular
    await user.click(screen.getByText("demo.yaml"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Load a campaign brief" })).toBeNull());
  });

  test("shows an error state when the request returns a non-JSON 5xx", async () => {
    vi.mocked(globalThis.fetch).mockImplementation((url) =>
      Promise.resolve(
        String(url).includes("/campaigns/briefs")
          ? new Response("<html>502</html>", { status: 502 }) // non-JSON → JSON.parse throws
          : json({ halted: false, assets: [], log: null }),
      ),
    );
    renderWithRun(<BriefPicker />);
    expect(await screen.findByText(/Could not load briefs/)).toBeTruthy();
  });

  test("shows the empty state when no briefs exist", async () => {
    routeBriefs({ briefs: [] });
    renderWithRun(<BriefPicker />);
    expect(await screen.findByText(/No briefs found/)).toBeTruthy();
  });

  test("closes on Escape", async () => {
    const user = userEvent.setup();
    routeBriefs({ briefs: [{ file: "demo.yaml", brief: { id: "demo", targetRegion: "DE", products: [{ id: "a" }], treatments: [{ id: "t" }] } }] });
    renderWithRun(<BriefPicker />);
    const dialog = await screen.findByRole("dialog", { name: "Load a campaign brief" });
    await screen.findByText("demo.yaml");
    exerciseFocusTrap(dialog);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Load a campaign brief" })).toBeNull());
  });
});

describe("TelemetryDrawer", () => {
  const seedLog = () => {
    localStorage.setItem(
      "cf:brief",
      JSON.stringify({ id: "log", targetRegion: "DE", targetAudience: "a", campaignMessage: "Hi", products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }] }),
    );
    vi.mocked(globalThis.fetch).mockResolvedValue(
      json({ halted: false, assets: [], log: { campaignId: "log", entries: [{ timestamp: "2026-01-01T10:00:00Z", stage: "Stage", message: "hello", level: "warn" }] } }),
    );
  };

  test("shows the idle message when there are no log entries", () => {
    renderWithRun(<TelemetryDrawer open onClose={() => {}} />);
    expect(screen.getByText(/Ready to orchestrate/)).toBeTruthy();
  });

  test("renders a placeholder time for an unparseable timestamp", async () => {
    localStorage.setItem(
      "cf:brief",
      JSON.stringify({ id: "log2", targetRegion: "DE", targetAudience: "a", campaignMessage: "Hi", products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }] }),
    );
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      json({ halted: false, assets: [], log: { campaignId: "log2", entries: [{ timestamp: "not-a-date", stage: "S", message: "m", level: "info" }] } }),
    );
    renderWithRun(<TelemetryDrawer open onClose={() => {}} />);
    expect(await screen.findByText("--:--:--")).toBeTruthy();
  });

  test("renders log entries and toggles expand", async () => {
    const user = userEvent.setup();
    seedLog();
    renderWithRun(<TelemetryDrawer open onClose={() => {}} />);
    expect(await screen.findByText("hello")).toBeTruthy();
    await user.click(screen.getByLabelText("Expand telemetry"));
    expect(screen.getByLabelText("Collapse telemetry")).toBeTruthy();
  });

  test("copies the log to the clipboard", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    seedLog();
    renderWithRun(<TelemetryDrawer open onClose={() => {}} />);
    await screen.findByText("hello");
    await user.click(screen.getByLabelText("Copy telemetry to clipboard"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(await screen.findByText(/Copied/)).toBeTruthy();
  });

  test("closes via the close button", async () => {
    const user = userEvent.setup();
    let closed = false;
    renderWithRun(<TelemetryDrawer open onClose={() => (closed = true)} />);
    await user.click(screen.getByLabelText("Close telemetry"));
    expect(closed).toBe(true);
  });
});
