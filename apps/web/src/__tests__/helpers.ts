import { render, fireEvent } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { vi, type Mock } from "vitest";
import { API, RunProvider, type Asset } from "@/lib/run-context";

/**
 * Drive a modal's focus trap through every branch: forward-Tab wrap from the last
 * focusable, backward shift+Tab wrap from the first, and a non-Tab key (early return).
 */
export const exerciseFocusTrap = (dialog: HTMLElement) => {
  const focusables = [
    ...dialog.querySelectorAll<HTMLElement>('a[href], button, input, [tabindex]:not([tabindex="-1"])'),
  ];
  // Focus every element and tab both ways, so the forward-wrap (at the last element)
  // and backward-wrap (at the first) both fire regardless of selector ordering.
  for (const el of focusables) {
    el.focus();
    fireEvent.keyDown(window, { key: "Tab" });
    el.focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  }
  fireEvent.keyDown(window, { key: "x" }); // non-Tab, non-Escape → early return
};

/** Render a UI tree wrapped in the shared RunProvider. */
export const renderWithRun = (ui: ReactElement) => render(createElement(RunProvider, null, ui));

export const makeAsset = (over: Partial<Asset> = {}): Asset => ({
  productId: "alpha",
  aspectRatio: "1:1",
  outputPath: "alpha/1x1.png",
  proofPath: "proofs/alpha.pdf",
  complianceScore: 0.5,
  passedCompliance: true,
  logoApplied: true,
  treatment: "default",
  backgroundSource: "procedural",
  ...over,
});

/** A fresh Response per call — a Response body can only be read once. */
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export type MockReport = { halted?: boolean; assets?: unknown[]; log?: unknown };

export const EMPTY_REPORT: MockReport = { halted: false, assets: [], log: null };

export const jobOk = (result: MockReport) => {
  const n = result.halted ? 0 : (result.assets?.length ?? 0);
  return json({ status: "completed", done: n, total: n, log: result.log ?? null, result });
};

type PostFn = (url: string, init: RequestInit) => Response | Promise<Response>;
type GetFn = (url: string) => Response | Promise<Response>;

const jobSnapshot = (report: MockReport): MockReport => ({
  ...report,
  log: report.log ?? { entries: [] },
});

/**
 * Shared pipeline fetch router. Default POST is 202 `{ jobId }` (`job-1` unless
 * `jobId` is set); GET `${API}/campaigns/jobs/` is a completed snapshot of
 * `report` (empty job if omitted); any other GET returns `report` (or `EMPTY_REPORT`).
 */
export const mockPipelineApi = (
  opts: {
    report?: MockReport;
    jobId?: string;
    post?: PostFn;
    job?: GetFn;
    result?: GetFn;
  } = {},
) => {
  if (!vi.isMockFunction(globalThis.fetch)) vi.spyOn(globalThis, "fetch");
  const report = opts.report ?? EMPTY_REPORT;
  return vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
    const u = String(url);
    const req = (init ?? {}) as RequestInit;
    if (req.method === "POST") {
      return Promise.resolve(opts.post ? opts.post(u, req) : json({ jobId: opts.jobId ?? "job-1" }, 202));
    }
    if (u.includes(`${API}/campaigns/jobs/`)) {
      return Promise.resolve(opts.job ? opts.job(u) : jobOk(jobSnapshot(report)));
    }
    return Promise.resolve(opts.result ? opts.result(u) : json(report));
  });
};

/**
 * Seed a persisted run that RunProvider restores on mount: stores a brief (so the
 * picker won't auto-open) and points the default fetch at a report with `assets`.
 */
export const seedPersistedRun = (assets: Asset[], opts: { halted?: boolean; id?: string } = {}) => {
  const id = opts.id ?? "seed";
  localStorage.setItem("cf:brief-picked", "1");
  localStorage.setItem(
    "cf:brief",
    JSON.stringify({
      id,
      targetRegion: "DE",
      targetAudience: "a",
      campaignMessage: "Stay wild",
      localizedMessage: "Bleib wild",
      products: [
        { id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" },
        { id: "beta", name: "Beta", primaryColor: "#E0218A", logoPath: "b.png" },
      ],
    }),
  );
  mockPipelineApi({
    report: { halted: opts.halted ?? false, assets, log: { entries: [], campaignId: id } },
  });
};

interface NextControls {
  nav: { pathname: string };
  router: Record<string, Mock>;
  redirect: Mock;
}

/** The controllable next/navigation mocks exposed by vitest.setup.ts. */
export const nextMock = (): NextControls =>
  (globalThis as unknown as { __next: NextControls }).__next;
