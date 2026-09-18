import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LogPanel, LOG_PANEL_SURFACE, type LogPanelEntry } from "../log-panel";

/** A run's rows, in the panel's vocabulary — what `TelemetryDrawer` maps to. */
const RUN_ROWS: LogPanelEntry[] = [
  { meta: "10:00:00", label: "Stage", message: "hello", level: "warn" },
  { meta: "10:00:01", label: "Render", message: "done", level: "info" },
];

/**
 * A validation view's rows: **no `meta`, no timestamp, no stage.** This is the
 * shape the extraction exists to serve, so it is fixed here as a literal rather
 * than derived from the run shape.
 */
const VALIDATION_ROWS: LogPanelEntry[] = [
  { label: "identity", message: "Campaign id is required", level: "error" },
  { label: "output", message: "Pick at least one size", level: "error" },
];

describe("LogPanel — the chrome", () => {
  test("it renders its title, its rows, and the surface both consumers share", () => {
    const { container } = render(<LogPanel title="A Title" entries={RUN_ROWS} />);

    expect(screen.getByText("A Title")).toBeTruthy();
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.getByText("[Stage]")).toBeTruthy();
    expect(screen.getByText("10:00:00")).toBeTruthy();

    // The surface is the shared definition, not a string this test restates.
    const root = container.firstElementChild as HTMLElement;
    for (const token of LOG_PANEL_SURFACE.split(/\s+/)) {
      expect(root.classList.contains(token)).toBe(true);
    }
  });

  test("the level colours the bracketed label, and `info` is the default", () => {
    render(
      <LogPanel
        title="t"
        entries={[
          { label: "a", message: "m1", level: "error" },
          { label: "b", message: "m2" },
        ]}
      />,
    );
    expect(screen.getByText("[a]").className).toContain("text-error");
    // No `level` given: the row must still be coloured, and quietly.
    expect(screen.getByText("[b]").className).toContain("text-info");
  });

  test("the empty message shows only when there is nothing pending", () => {
    const { rerender } = render(
      <LogPanel title="t" entries={[]} emptyMessage="nothing here" loadingMessage="waiting…" />,
    );
    expect(screen.getByText("nothing here")).toBeTruthy();
    expect(screen.queryByText("waiting…")).toBeNull();

    rerender(
      <LogPanel
        title="t"
        entries={[]}
        loading
        emptyMessage="nothing here"
        loadingMessage="waiting…"
      />,
    );
    // Announced, not merely drawn — a wait nobody is told about is a hang.
    expect(screen.getByRole("status").textContent).toBe("waiting…");
    expect(screen.queryByText("nothing here")).toBeNull();
  });

  test("rows win over both states: a panel with entries never shows a skeleton", () => {
    render(
      <LogPanel
        title="t"
        entries={RUN_ROWS}
        loading
        emptyMessage="nothing"
        loadingMessage="wait"
      />,
    );
    expect(screen.getByText("hello")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("nothing")).toBeNull();
  });

  test("instance controls land in the header, beside the Copy control", () => {
    render(
      <LogPanel
        title="t"
        entries={RUN_ROWS}
        copyLabel="Copy it"
        actions={<button type="button">Refresh</button>}
      />,
    );
    const header = screen.getByText("t").parentElement as HTMLElement;
    expect(within(header).getByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "Copy it" })).toBeTruthy();
  });

  test("no `copyLabel` means no Copy control at all", () => {
    render(<LogPanel title="t" entries={RUN_ROWS} />);
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
  });
});

describe("LogPanel — Copy", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  test("it writes `meta [label] message` per row, and says it copied", async () => {
    // `userEvent.setup()` installs a clipboard stub of its own, so the mock has
    // to be defined AFTER it or the stub wins and every assertion here measures
    // user-event instead of the panel. This order is the repo's existing one
    // (`coverage-gaps.test.tsx`'s clipboard edges) and it is load-bearing.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<LogPanel title="t" entries={RUN_ROWS} copyLabel="Copy it" />);
    await user.click(screen.getByRole("button", { name: "Copy it" }));

    // The drawer's own format, which is why the extraction needed no formatter
    // prop: a run row's `meta` is its time and its `label` is its stage.
    expect(writeText).toHaveBeenCalledWith("10:00:00 [Stage] hello\n10:00:01 [Render] done");
    expect(screen.getByRole("button", { name: "Copied ✓" })).toBeTruthy();
  });

  test("a row with no meta and no label copies as its message alone", async () => {
    // `userEvent.setup()` installs a clipboard stub of its own, so the mock has
    // to be defined AFTER it or the stub wins and every assertion here measures
    // user-event instead of the panel. This order is the repo's existing one
    // (`coverage-gaps.test.tsx`'s clipboard edges) and it is load-bearing.
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<LogPanel title="t" entries={[{ message: "bare" }]} copyLabel="Copy it" />);
    await user.click(screen.getByRole("button", { name: "Copy it" }));

    // No stray brackets and no leading space — the shape is built from what is
    // present, not from a template with holes in it.
    expect(writeText).toHaveBeenCalledWith("bare");
  });

  test("Copy is disabled with nothing to copy", () => {
    render(<LogPanel title="t" entries={[]} copyLabel="Copy it" emptyMessage="none" />);
    expect((screen.getByRole("button", { name: "Copy it" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("a clipboard that rejects does not break the panel", async () => {
    // Defined after `setup()` — see the note above; with the order reversed this
    // test measured user-event's own stub, which resolves, and so asserted the
    // opposite of its name.
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("insecure context"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<LogPanel title="t" entries={RUN_ROWS} copyLabel="Copy it" />);
    await user.click(screen.getByRole("button", { name: "Copy it" }));

    // Still resting, and still usable.
    expect(screen.getByRole("button", { name: "Copy it" })).toBeTruthy();
  });
});

/**
 * The claim the extraction exists to make. LP1 is only worth its diff if a
 * consumer whose rows were never run-shaped can wear the panel — so this is
 * asserted, not assumed, and it is asserted with rows that carry **no**
 * timestamp and **no** stage.
 */
describe("LogPanel — the second consumer (SG-D21)", () => {
  test("validation-shaped rows render, with no invented time or stage", () => {
    const { container } = render(
      <LogPanel title="Validation" entries={VALIDATION_ROWS} copyLabel="Copy the errors" />,
    );

    expect(screen.getByText("Campaign id is required")).toBeTruthy();
    expect(screen.getByText("[identity]")).toBeTruthy();
    expect(screen.getByText("Pick at least one size")).toBeTruthy();

    // Nothing stands in for the absent columns. Asserted as the row's EXACT
    // text rather than as the absence of a few strings: an empty `<span>` and a
    // stray separator space both leave `not.toContain(…)` green while putting a
    // column on the row that the data does not have. This also pins that the
    // panel invents no clock — the drawer's `--:--:--` placeholder belongs to
    // the drawer's mapping, and a row no run produced must carry no time at all.
    const rows = [...(container.querySelectorAll("[class*='text-text-primary']") ?? [])].map(
      (el) => el.parentElement?.textContent,
    );
    expect(rows).toEqual(["[identity] Campaign id is required", "[output] Pick at least one size"]);
  });

  test("it renders with no run context in the tree at all", () => {
    // Behavioural proof of the decoupling the layer rules also enforce: if the
    // panel read `useRun()`, this bare render would throw (the app's provider
    // hook throws outside its provider).
    expect(() => render(<LogPanel title="t" entries={VALIDATION_ROWS} />)).not.toThrow();
  });
});
