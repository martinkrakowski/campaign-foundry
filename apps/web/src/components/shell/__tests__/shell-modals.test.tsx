import { describe, test, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRun, exerciseFocusTrap, json, mockPipelineApi, EMPTY_REPORT } from "@/__tests__/helpers";
import { useRun } from "@/lib/run-context";
import { ModelSelector } from "../ModelSelector";
import { createElement, useEffect } from "react";
import { RunProvider } from "@/lib/run-context";
import { EditorDirtyProvider, useEditorDirty } from "@/lib/editor-dirty-context";
import { render } from "@testing-library/react";
import { BriefPicker } from "../BriefPicker";
import { TelemetryDrawer } from "../TelemetryDrawer";

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

  test("reports the chosen model's label so the header can say what runs next", async () => {
    const user = userEvent.setup();
    const onModelChange = vi.fn();
    renderWithRun(<ModelSelector onModelChange={onModelChange} />);
    await user.click(screen.getByTitle("Change image model"));
    const dialog = await screen.findByRole("dialog", { name: "Select image model" });
    await user.click(within(dialog).getByText("Nano Banana"));
    // A label, never the raw id (`google/gemini-2.5-flash-image`) — and exactly once,
    // because `toHaveBeenCalledWith` alone passes against a callback that double-fires.
    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onModelChange).toHaveBeenCalledWith("Nano Banana");
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
    mockPipelineApi({
      result: (url) => (url.includes("/campaigns/briefs") ? json(body, ok ? 200 : 500) : json(EMPTY_REPORT)),
    });

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
    mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/briefs")
          ? new Response("<html>502</html>", { status: 502 }) // non-JSON → JSON.parse throws
          : json(EMPTY_REPORT),
    });
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
    mockPipelineApi({
      report: { halted: false, assets: [], log: { campaignId: "log", entries: [{ timestamp: "2026-01-01T10:00:00Z", stage: "Stage", message: "hello", level: "warn" }] } },
    });
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
    mockPipelineApi({
      report: { halted: false, assets: [], log: { campaignId: "log2", entries: [{ timestamp: "not-a-date", stage: "S", message: "m", level: "info" }] } },
    });
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
    // Re-queried by NAME, not reusing the stale handle: the point of the fix is that
    // the accessible name follows the visible text, so the confirmation is announced.
    const copiedBtn = await screen.findByRole("button", { name: "Copied ✓" });
    expect(copiedBtn.textContent).toBe("Copied ✓");
  });

  test("closes via the close button", async () => {
    const user = userEvent.setup();
    let closed = false;
    renderWithRun(<TelemetryDrawer open onClose={() => (closed = true)} />);
    await user.click(screen.getByLabelText("Close telemetry"));
    expect(closed).toBe(true);
  });

  test("a run in flight that has not spoken yet is announced, not shown as idle", async () => {
    const user = userEvent.setup();
    // Nothing to restore, and the generate POST never settles: the run stays in
    // flight with an empty log — the one state where a skeleton says something the
    // "[SYSTEM] Ready" idle line would get wrong.
    localStorage.setItem(
      "cf:brief",
      JSON.stringify({ id: "log4", targetRegion: "DE", targetAudience: "a", campaignMessage: "Hi", products: [] }),
    );
    mockPipelineApi({ report: EMPTY_REPORT, post: () => new Promise<Response>(() => {}) });

    const Harness = () => {
      const { execute } = useRun();
      return (
        <>
          <button type="button" onClick={() => void execute()}>
            go
          </button>
          <TelemetryDrawer open onClose={() => {}} />
        </>
      );
    };
    renderWithRun(<Harness />);
    await user.click(screen.getByText("go"));

    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Waiting for the run to report");
    expect(screen.queryByText(/Ready to orchestrate/)).toBeNull();
    // `bg-border`, not `Skeleton`'s own `bg-surface-2`: the log panel is `surface-2` now
    // (a black panel cannot carry theme text — see TelemetryDrawer), and a skeleton that
    // matched its ground would be no placeholder at all.
    expect(document.querySelectorAll('div[aria-hidden="true"].bg-border').length).toBe(2);
  });
});

describe("BriefPicker with unsaved editor changes", () => {
  beforeEach(() => localStorage.removeItem("cf:brief-picked"));

  /** Render inside the real providers with the dirty flag already raised. */
  const renderDirty = () => {
    const RaiseDirty = () => {
      const { setDirty } = useEditorDirty();
      useEffect(() => setDirty(true), [setDirty]);
      return null;
    };
    return render(
      createElement(
        RunProvider,
        null,
        createElement(EditorDirtyProvider, null, createElement(RaiseDirty), createElement(BriefPicker)),
      ),
    );
  };

  const routeBriefs = (body: unknown) =>
    mockPipelineApi({
      result: (url) => (url.includes("/campaigns/briefs") ? json(body) : json(EMPTY_REPORT)),
    });

  test("refusing the prompt keeps the picker open and loads nothing", async () => {
    const user = userEvent.setup();
    routeBriefs({ briefs: [{ file: "demo.yaml", brief: { id: "demo", targetRegion: "DE", products: [{ id: "a" }] } }] });
    renderDirty();

    await user.click(await screen.findByText("demo.yaml"));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(dialog).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull());
    expect(screen.getByText("demo.yaml")).toBeTruthy();
  });

  test("refusing the prompt on Start from scratch also leaves the picker open", async () => {
    const user = userEvent.setup();
    routeBriefs({ briefs: [] });
    renderDirty();

    await user.click(await screen.findByText("Create new"));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(dialog).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Unsaved edits" })).toBeNull());
  });
});

describe("BriefPicker when the prompt is accepted", () => {
  beforeEach(() => localStorage.removeItem("cf:brief-picked"));

  const renderDirty = () => {
    const RaiseDirty = () => {
      const { setDirty } = useEditorDirty();
      useEffect(() => setDirty(true), [setDirty]);
      return null;
    };
    return render(
      createElement(
        RunProvider,
        null,
        createElement(EditorDirtyProvider, null, createElement(RaiseDirty), createElement(BriefPicker)),
      ),
    );
  };

  test("accepting loads the chosen brief and closes the picker", async () => {
    const user = userEvent.setup();
    mockPipelineApi({
      result: (url) =>
        url.includes("/campaigns/briefs")
          ? json({ briefs: [{ file: "demo.yaml", brief: { id: "demo", targetRegion: "DE", products: [{ id: "a" }] } }] })
          : json(EMPTY_REPORT),
    });
    renderDirty();

    await user.click(await screen.findByText("demo.yaml"));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(dialog).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(screen.queryByText("demo.yaml")).toBeNull());
  });

  test("accepting on Create new closes the picker too", async () => {
    const user = userEvent.setup();
    mockPipelineApi({
      result: (url) => (url.includes("/campaigns/briefs") ? json({ briefs: [] }) : json(EMPTY_REPORT)),
    });
    renderDirty();

    await user.click(await screen.findByText("Create new"));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved edits" });
    expect(dialog).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(screen.queryByText("Create new")).toBeNull());
  });
});
