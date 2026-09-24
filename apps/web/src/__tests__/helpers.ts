import { render, fireEvent } from "@testing-library/react";
import { createElement, type ReactElement, type ReactNode } from "react";
import { afterEach, vi, type Mock } from "vitest";
import { API, RunProvider, assetKey, type Asset } from "@/lib/run-context";
import { EditorDirtyProvider } from "@/lib/editor-dirty-context";
import { EditorPanelsProvider, EditorPanelsOutlet } from "@/lib/editor-panels-context";
import { MobileRailProvider } from "@/lib/mobile-rail-context";
import { templateFromCanonical } from "@campaignfoundry/CampaignOrchestration/brief-template";
import { DEFAULT_CAMPAIGN_TYPE } from "@campaignfoundry/CampaignOrchestration/campaign-types";

/**
 * Drive a modal's focus trap through every branch: forward-Tab wrap from the last
 * focusable, backward shift+Tab wrap from the first, and a non-Tab key (early return).
 */
export const exerciseFocusTrap = (dialog: HTMLElement) => {
  const focusables = [
    ...dialog.querySelectorAll<HTMLElement>(
      'a[href], button, input, [tabindex]:not([tabindex="-1"])',
    ),
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

/** Render a UI tree wrapped in the shared RunProvider and EditorDirtyProvider. */
/** The shell's provider tree, for tests that build it by hand (e.g. a manual rerender). */
export const ShellProviders = ({ children }: { children: ReactNode }) =>
  createElement(
    RunProvider,
    null,
    createElement(
      EditorDirtyProvider,
      null,
      // The outlet stands in for the sidebar: an editor publishes its mode chooser and
      // policy panel there, so a test that renders only the editor must still place them.
      createElement(
        EditorPanelsProvider,
        null,
        // SG11 — inside the panels provider, as in `(shell)/layout.tsx`: the mobile
        // menu's entry to the rail reads both, so a test rendering `Header` (which
        // renders `MobileMenu`) needs this one too. Both providers throw outside
        // themselves rather than defaulting, which is why it belongs here and not
        // behind an optional read — a context that quietly defaults hides exactly
        // the wiring bug it would be papering over.
        createElement(MobileRailProvider, null, children, createElement(EditorPanelsOutlet)),
      ),
    ),
  );

export const renderWithRun = (ui: ReactElement) => render(createElement(ShellProviders, null, ui));

/** The canonical creative template a stored-brief fixture must carry (required since L3a). */
export const storedTemplate = templateFromCanonical(DEFAULT_CAMPAIGN_TYPE);

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

/** A motion variation asset: mp4 + poster, 6 s ken-burns-in, with its descriptor. */
export const makeMotionAsset = (over: Partial<Asset> = {}): Asset =>
  makeAsset({
    aspectRatio: "9:16",
    outputPath: "alpha/9x16/v1.png",
    videoPath: "alpha/9x16/v1.mp4",
    durationSec: 6,
    format: "motion",
    variantIndex: 1,
    attempt: 0,
    treatment: "headline-top-bold",
    descriptor: {
      layout: "headline-top",
      tone: "bold",
      backgroundSource: "procedural",
      paletteShift: 0,
      motion: "ken-burns-in",
      durationSec: 6,
    },
    ...over,
  });

/** A fresh Response per call — a Response body can only be read once. */
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export type MockReport = {
  halted?: boolean;
  assets?: unknown[];
  log?: unknown;
  policyHash?: string;
  seed?: number;
};

export const EMPTY_REPORT: MockReport = { halted: false, assets: [], log: null };

export const jobOk = (result: MockReport) => {
  const n = result.halted ? 0 : (result.assets?.length ?? 0);
  return json({ status: "completed", done: n, total: n, log: result.log ?? null, result });
};

type PostFn = (url: string, init: RequestInit) => Response | Promise<Response>;
type GetFn = (url: string) => Response | Promise<Response>;

const isPlanUrl = (u: string) => u.includes("/campaigns/plan");
const isPackagePostUrl = (u: string) => /\/campaigns\/package(?:\?|$)/.test(u);
const isPackagesGetUrl = (u: string) => u.includes("/campaigns/packages");
const isDecisionsUrl = (u: string) => u.includes("/campaigns/decisions");

type Verdicts = Record<string, "approved" | "rejected">;

let seededVerdicts: Verdicts | undefined;
afterEach(() => {
  seededVerdicts = undefined;
});

/**
 * Seed the decisions the server holds for this test: every `mockPipelineApi`
 * that does not pass its own `decisions` serves these (D173, where
 * `cf:decisions` used to be seeded).
 */
export const seedDecisions = (verdicts: Verdicts) => {
  seededVerdicts = verdicts;
};

/**
 * The decisions endpoint as the server keeps it (D173), in memory: GET answers
 * the stored records and their revision; PUT must name that revision (409
 * otherwise) and answers the new one. `verdicts` seeds it.
 */
export const fakeDecisionsApi = (verdicts: Verdicts = {}) => {
  let stored: Verdicts = { ...verdicts };
  let revision: string | null = Object.keys(stored).length > 0 ? "rev-0" : null;
  let saves = 0;
  const answer = () =>
    json({
      decisions: Object.fromEntries(
        Object.entries(stored).map(([k, verdict]) => [
          k,
          { verdict, actor: "local", at: "t", run: "r" },
        ]),
      ),
      revision,
    });
  return {
    handle(_url: string, init: RequestInit): Response {
      if (init.method !== "PUT") return answer();
      const body = JSON.parse(String(init.body)) as {
        revision: string | null;
        decisions: Verdicts;
      };
      if (body.revision !== revision) return json({ error: "changed", revision }, 409);
      stored = { ...body.decisions };
      revision = `rev-${(saves += 1)}`;
      return answer();
    },
    /**
     * A generate POST: the report write that follows retires what it replaces —
     * the re-rolled cells, or every decision on a full run (D173).
     */
    retire(init: RequestInit) {
      let body: unknown = null;
      try {
        body = JSON.parse(String(init.body ?? "null"));
      } catch {
        /* not a JSON body: treat as a full run */
      }
      const parsed = body as {
        regenerateOnly?: Parameters<typeof assetKey>[0][];
      } | null;
      const keys = parsed?.regenerateOnly?.map(assetKey);
      const next =
        keys === undefined
          ? {}
          : Object.fromEntries(Object.entries(stored).filter(([k]) => !keys.includes(k)));
      if (Object.keys(next).length === Object.keys(stored).length) return;
      this.saveElsewhere(next);
    },
    /** What the server holds now. */
    get stored(): Verdicts {
      return { ...stored };
    },
    /** Another tab's save: the stored map and its revision move. */
    saveElsewhere(next: Verdicts) {
      stored = { ...next };
      revision = `rev-${(saves += 1)}`;
    },
  };
};

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
    plan?: PostFn;
    packagePost?: PostFn;
    packages?: GetFn;
    /** The decisions the server holds (a fresh fake), or a fake a test drives. */
    decisions?: Verdicts | ReturnType<typeof fakeDecisionsApi>;
  } = {},
) => {
  if (!vi.isMockFunction(globalThis.fetch)) vi.spyOn(globalThis, "fetch");
  const report = opts.report ?? EMPTY_REPORT;
  const given = opts.decisions;
  const decisions: ReturnType<typeof fakeDecisionsApi> =
    given !== undefined && typeof given.handle === "function"
      ? (given as ReturnType<typeof fakeDecisionsApi>)
      : fakeDecisionsApi((given as Verdicts | undefined) ?? seededVerdicts);
  return vi.mocked(globalThis.fetch).mockImplementation((url, init) => {
    const u = String(url);
    const req = (init ?? {}) as RequestInit;
    if (isDecisionsUrl(u)) return Promise.resolve(decisions.handle(u, req));
    if (req.method === "POST") {
      if (isPlanUrl(u)) {
        if (opts.plan) return Promise.resolve(opts.plan(u, req));
        if (opts.post) return Promise.resolve(opts.post(u, req));
        return Promise.resolve(json({ error: "not a variation brief" }, 400));
      }
      if (isPackagePostUrl(u)) {
        if (opts.packagePost) return Promise.resolve(opts.packagePost(u, req));
        if (opts.post) return Promise.resolve(opts.post(u, req));
        return Promise.resolve(json({ platforms: [] }));
      }
      decisions.retire(req);
      return Promise.resolve(
        opts.post ? opts.post(u, req) : json({ jobId: opts.jobId ?? "job-1" }, 202),
      );
    }
    if (u.includes(`${API}/campaigns/jobs/`)) {
      return Promise.resolve(opts.job ? opts.job(u) : jobOk(jobSnapshot(report)));
    }
    if (isPackagesGetUrl(u)) {
      return Promise.resolve(opts.packages ? opts.packages(u) : json({ error: "Not found" }, 404));
    }
    return Promise.resolve(opts.result ? opts.result(u) : json(report));
  });
};

/**
 * Seed a persisted run that RunProvider restores on mount: stores a brief (so the
 * picker won't auto-open) and points the default fetch at a report with `assets`.
 */
export const seedPersistedRun = (
  assets: Asset[],
  opts: {
    halted?: boolean;
    id?: string;
    policyHash?: string;
    seed?: number;
    decisions?: Verdicts | ReturnType<typeof fakeDecisionsApi>;
  } = {},
) => {
  const id = opts.id ?? "seed";
  // A classic brief never produces `variantIndex` assets, so a run carrying them must
  // sit under a randomized brief — otherwise the fixture models a state the app cannot
  // reach, and the re-roll mode guard (rightly) refuses it.
  const randomized = assets.some((asset) => asset.variantIndex !== undefined);
  localStorage.setItem("cf:brief-picked", "1");
  localStorage.setItem(
    "cf:brief",
    JSON.stringify({
      id,
      targetRegion: "DE",
      targetAudience: "a",
      campaignMessage: "Stay wild",
      localizedMessage: "Bleib wild",
      template: storedTemplate,
      products: [
        { id: "alpha", name: "Alpha", primaryColor: "#1473E6", logoPath: "a.png" },
        { id: "beta", name: "Beta", primaryColor: "#E0218A", logoPath: "b.png" },
      ],
      ...(randomized
        ? { mode: "variation", variation: { count: Math.max(1, assets.length) } }
        : {}),
    }),
  );
  mockPipelineApi({
    report: {
      halted: opts.halted ?? false,
      assets,
      log: { entries: [], campaignId: id },
      ...(opts.policyHash !== undefined ? { policyHash: opts.policyHash } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    },
    ...(opts.decisions !== undefined ? { decisions: opts.decisions } : {}),
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
