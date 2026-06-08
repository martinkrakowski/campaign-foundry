import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, Fragment } from "react";
import { renderWithRun, seedPersistedRun, makeAsset } from "@/__tests__/helpers";
import { useRun } from "@/lib/run-context";
import { CommandBar } from "@/components/shell/CommandBar";
import { Sidebar } from "@/components/shell/Sidebar";
import { TelemetryDrawer } from "@/components/shell/TelemetryDrawer";
import { Card } from "@/components/ui/card";
import ExportPage from "@/app/(shell)/export/page";
import RunsPage from "@/app/(shell)/runs/page";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const EMPTY = { halted: false, assets: [], log: null };

beforeEach(() => localStorage.setItem("cf:brief-picked", "1"));

const seedSingle = (assets: ReturnType<typeof makeAsset>[], postPending = false) => {
  localStorage.setItem("cf:brief", JSON.stringify({ id: "seed", targetRegion: "DE", targetAudience: "a", campaignMessage: "Hi", products: [{ id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" }] }));
  vi.mocked(globalThis.fetch).mockImplementation((_url, init) => {
    if ((init as RequestInit | undefined)?.method === "POST") return postPending ? new Promise<Response>(() => {}) : Promise.resolve(json({ halted: false, assets, log: { entries: [], campaignId: "seed" } }));
    return Promise.resolve(json({ halted: false, assets, log: { entries: [], campaignId: "seed" } }));
  });
};

describe("CommandBar — states", () => {
  test("shows the halted status", async () => {
    seedPersistedRun([], { halted: true });
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    expect(await screen.findByText(/Pipeline halted — review required/)).toBeTruthy();
  });

  test("shows the error status when a run fails", async () => {
    const user = userEvent.setup();
    vi.mocked(globalThis.fetch).mockImplementation((_url, init) =>
      (init as RequestInit | undefined)?.method === "POST" ? Promise.resolve(new Response("boom", { status: 500 })) : Promise.resolve(json(EMPTY)),
    );
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    await user.click(screen.getByText(/Execute/));
    await user.click(within(await screen.findByRole("dialog")).getByText("Generate"));
    await waitFor(() => expect(screen.getByText(/Pipeline API unreachable/)).toBeTruthy());
  });

  test("a re-run confirm reflects the existing run, with plural rejected copy", async () => {
    const user = userEvent.setup();
    localStorage.setItem("cf:decisions", JSON.stringify({ "alpha/1:1/default": "rejected", "beta/1:1/default": "rejected" }));
    seedPersistedRun([makeAsset(), makeAsset({ productId: "beta", outputPath: "beta/1x1.png" })]);
    renderWithRun(<CommandBar onToggleTelemetry={() => {}} />);
    const regenButton = await screen.findByRole("button", { name: /Regenerate Rejected/ });
    await user.click(screen.getByText(/Execute/));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Regenerate the entire pipeline/)).toBeTruthy(); // hasRun branch
    await user.click(within(dialog).getByText("Cancel"));
    await user.click(regenButton);
    expect(await screen.findByText(/2 rejected/)).toBeTruthy(); // plural copy
  });
});

describe("RunsPage — running and rejected", () => {
  function Harness() {
    const { execute } = useRun();
    return createElement(Fragment, null, createElement("button", { onClick: () => execute(), key: "b" }, "go"), createElement(RunsPage, { key: "p" }));
  }

  test("counts rejected creatives and shows the running badge", async () => {
    const user = userEvent.setup();
    localStorage.setItem("cf:decisions", JSON.stringify({ "alpha/1:1/default": "rejected" }));
    seedSingle([makeAsset()], true);
    renderWithRun(<Harness />);
    await screen.findByText("complete");
    await user.click(screen.getByText("go")); // execute stays pending → loading
    await waitFor(() => expect(screen.getByText("running")).toBeTruthy());
  });
});

describe("ExportPage — approved render without a proof", () => {
  test("renders zero proofs when an approved creative has none", async () => {
    localStorage.setItem("cf:decisions", JSON.stringify({ "alpha/1:1/default": "approved" }));
    seedPersistedRun([makeAsset({ proofPath: undefined })]);
    renderWithRun(<ExportPage />);
    await waitFor(() => expect(screen.getByText(/1 of 1 creatives approved/)).toBeTruthy());
    expect(screen.getByText(/Proof PDFs \(0\)/)).toBeTruthy();
  });
});

describe("Sidebar — localized fallback", () => {
  test("falls back to the campaign message when no localized copy is set", async () => {
    localStorage.setItem("cf:brief", JSON.stringify({ id: "nolocale", targetRegion: "DE", targetAudience: "a", campaignMessage: "Plain message", products: [{ id: "p", name: "P", primaryColor: "#111111", logoPath: "l.png" }] }));
    renderWithRun(<Sidebar />);
    expect(await screen.findByText("Plain message")).toBeTruthy();
  });
});

describe("TelemetryDrawer — clipboard edges", () => {
  const seedLog = () => {
    localStorage.setItem("cf:brief", JSON.stringify({ id: "log3", targetRegion: "DE", targetAudience: "a", campaignMessage: "Hi", products: [{ id: "p1", name: "P1", primaryColor: "#111111", logoPath: "a.png" }] }));
    vi.mocked(globalThis.fetch).mockImplementation(async () => json({ halted: false, assets: [], log: { campaignId: "log3", entries: [{ timestamp: "2026-01-01T10:00:00Z", stage: "S", message: "hello", level: "info" }] } }));
  };

  test("copy is a no-op when the clipboard API is unavailable", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    seedLog();
    renderWithRun(<TelemetryDrawer open onClose={() => {}} />);
    await screen.findByText("hello");
    await user.click(screen.getByLabelText("Copy telemetry to clipboard"));
    expect(screen.queryByText(/Copied/)).toBeNull();
  });

  test("rapid copies reset the prior timer", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => {}) }, configurable: true });
    seedLog();
    renderWithRun(<TelemetryDrawer open onClose={() => {}} />);
    await screen.findByText("hello");
    const copy = screen.getByLabelText("Copy telemetry to clipboard");
    await user.click(copy);
    await user.click(copy); // second click clears the pending reset timer
    expect(await screen.findByText(/Copied/)).toBeTruthy();
  });

  test("resets the Copied indicator after the timeout elapses", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => {}) }, configurable: true });
    seedLog();
    renderWithRun(<TelemetryDrawer open onClose={() => {}} />);
    await screen.findByText("hello");
    await user.click(screen.getByLabelText("Copy telemetry to clipboard"));
    expect(await screen.findByText(/Copied/)).toBeTruthy();
    // The 1500ms reset timer fires (real timers) → label returns to "Copy".
    await waitFor(() => expect(screen.getByLabelText("Copy telemetry to clipboard").textContent).toBe("Copy"), {
      timeout: 2500,
    });
  });
});

describe("Card", () => {
  test("renders with no children", () => {
    const { container } = render(<Card />);
    expect(container.querySelector("div")).toBeTruthy();
  });
});
