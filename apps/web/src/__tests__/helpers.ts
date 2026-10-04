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

/**
 * One classic asset: paths and compliance, and **no `*Url` field at all**.
 *
 * **Deliberate, not an oversight (D204/D213).** A default URL here would be a
 * default the real system does not have: the API mints URLs per RESPONSE on
 * `result.get`, and the jobs route mints none — so a fixture that conjured them at
 * asset-construction time would put them where no real answer carries them, and
 * every test would silently stop describing the ABSENT case. A test that means a
 * URL says so explicitly, with {@link fsUrls} or {@link s3Urls} for the backend it
 * means, and a test that means "the server could not sign one" is this.
 */
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

/**
 * The completed job's snapshot, as `GET /campaigns/jobs/:id` answers it.
 *
 * **Every `*Url` key is stripped here, not only in {@link jobSnapshot}.** That
 * route returns the job exactly as stored and mints no URLs (D204, D213):
 * `withAssetUrls` runs on `result.get` alone, after its ownership check. Stripping
 * in the one builder every test goes through means a test that passes its OWN `job`
 * handler gets the real jobs-route shape too — otherwise a fixture's signed URLs
 * would ride the job payload into the commit, and a test could pass on a URL the
 * server never sends through that route (Qodo, CodeRabbit). It is what makes "the
 * committed row came from the result read" an assertion rather than a hope.
 */
export const jobOk = (result: MockReport) => {
  const n = result.halted ? 0 : (result.assets?.length ?? 0);
  return json({
    status: "completed",
    done: n,
    total: n,
    log: result.log ?? null,
    result: {
      ...result,
      ...(result.assets !== undefined ? { assets: result.assets.map(stripAssetUrls) } : {}),
    },
  });
};

type PostFn = (url: string, init: RequestInit) => Response | Promise<Response>;
type GetFn = (url: string) => Response | Promise<Response>;

const isPlanUrl = (u: string) => u.includes("/campaigns/plan");
const isPackagePostUrl = (u: string) => /\/campaigns\/package(?:\?|$)/.test(u);
const isPackagesGetUrl = (u: string) => u.includes("/campaigns/packages");
const isDecisionsUrl = (u: string) => u.includes("/campaigns/decisions");

type Verdicts = Record<string, "approved" | "rejected">;

let seededVerdicts: Verdicts | undefined;
/**
 * The campaign this test seeded (PT-5e), if any. A test that seeds a campaign
 * and then re-mocks the API to drive one route — a re-roll's job, a second
 * campaign's report — means the same thing by the second mock, so the seed is a
 * property of the TEST rather than of one mock installation, exactly as
 * `seededVerdicts` is. Cleared per test, so nothing leaks into the next.
 */
let seededCampaign: OpenedCampaign | undefined;
afterEach(() => {
  seededVerdicts = undefined;
  seededCampaign = undefined;
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
    /** What the server holds now (a method, so a spread copy still reads it live). */
    stored(): Verdicts {
      return { ...stored };
    },
    /** Another tab's save: the stored map and its revision move. */
    saveElsewhere(next: Verdicts) {
      stored = { ...next };
      revision = `rev-${(saves += 1)}`;
    },
  };
};

/**
 * The default completed-job payload: the seeded report with a `log`, and — as the
 * jobs route answers it — **no `*Url` on any row**.
 *
 * The strip is the same one {@link jobOk} applies, and it is here as well so the
 * default `job` handler and a test's own one cannot disagree about what a job
 * payload is. A fixture's signed URLs must reach the shell through
 * `GET /campaigns/result` and nowhere else (D204, D213).
 */
const jobSnapshot = (report: MockReport): MockReport => ({
  ...report,
  ...(report.assets !== undefined ? { assets: report.assets.map(stripAssetUrls) } : {}),
  log: report.log ?? { entries: [] },
});

/** One report row with every `*Url` key removed — a non-object row passes through. */
function stripAssetUrls(row: unknown): unknown {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return row;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.endsWith("Url")) kept[key] = value;
  }
  return kept;
}

/**
 * The store's own origin and prefix, as an `s3` deployment signs them (D204).
 * Deliberately not the fs route: a fixture whose URLs were same-origin could not
 * tell a display URL from a download one, which is the whole difference D212 adds.
 */
const S3_ORIGIN = "https://objects.example";
const S3_BUCKET = "campaign-foundry";
const S3_PREFIX = "org/local/campaign/00000000-0000-4000-8000-000000000000/renders";
/** A 64-hex signature, so a URL parsed in an assertion is recognisably a signed one. */
const S3_SIGNATURE = "b".repeat(64);

/** A path's own last segment — the filename a `s3` attachment is signed under. */
const lastSegment = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/**
 * `*Url` fields shaped as the fs backend mints them (D204, D209c): the output route
 * plus the path, with the report revision as the single `?v=` query.
 *
 * **The two download fields are the SAME STRING as their display siblings here**,
 * which is D212's fs half: the URL is same-origin, `<a download>` works, and there
 * is no store to sign a second, disposition-carrying signature. So `fsUrls` is a
 * total function of the row and the revision, and `toBe` equality against its own
 * `outputUrl` is an invariant a test can state rather than a coincidence.
 */
export const fsUrls = (asset: Asset, revision = FS_REVISION): Partial<Asset> => {
  const route = (path: string): string => `${API}/output/${path}?v=${revision}`;
  const outputUrl = route(asset.outputPath);
  const videoUrl = asset.videoPath === undefined ? undefined : route(asset.videoPath);
  const urls: Partial<Asset> = { outputUrl, outputDownloadUrl: outputUrl };
  if (videoUrl !== undefined) {
    urls.videoUrl = videoUrl;
    urls.videoDownloadUrl = videoUrl;
  }
  if (asset.proofPath !== undefined) urls.proofUrl = route(asset.proofPath);
  if (asset.htmlFallbackPath !== undefined) urls.htmlFallbackUrl = route(asset.htmlFallbackPath);
  if (asset.htmlBundlePath !== undefined)
    urls.htmlBundleUrl = `${API}/output/${asset.htmlBundlePath}?v=${revision}`;
  return urls;
};

/** The revision an `fsUrls` fixture carries unless a test names another. */
export const FS_REVISION = "9f".repeat(32);

/**
 * `*Url` fields shaped as the `s3` backend mints them (D204, D209a, D212): a
 * presigned GET on the STORE'S origin, a 20-minute expiry, the report revision as
 * the signed `v`, and — for the two download fields — `response-content-disposition`
 * under the path's own last segment.
 *
 * **Each download URL differs from its display sibling by exactly that one
 * parameter**, which is the point of the fixture: a consumer that reached for
 * `outputUrl` where it should have reached for `outputDownloadUrl` fails a `toBe`
 * here, instead of passing on a shape the two backends happen to share.
 */
export const s3Urls = (asset: Asset, revision = FS_REVISION): Partial<Asset> => {
  // The key drops the campaign's SLUG (it is in the prefix) — the same join the
  // exporter made, so a fixture URL names a key a real report could have written.
  // `asAttachment` names the file under the disposition; without it the URL is the
  // DISPLAY one, which is what makes the pair distinguishable at all.
  const signed = (path: string, asAttachment?: string): string => {
    const key = `${S3_PREFIX}/${path.slice(path.indexOf("/") + 1)}`;
    const params = new URLSearchParams({
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Expires": "1200",
      v: revision,
      "X-Amz-Signature": S3_SIGNATURE,
      ...(asAttachment === undefined
        ? {}
        : { "response-content-disposition": `attachment; filename="${asAttachment}"` }),
    });
    return `${S3_ORIGIN}/${S3_BUCKET}/${key}?${params.toString()}`;
  };
  const attach = (path: string): string => signed(path, lastSegment(path));
  const urls: Partial<Asset> = {
    outputUrl: signed(asset.outputPath),
    outputDownloadUrl: attach(asset.outputPath),
  };
  if (asset.videoPath !== undefined) {
    urls.videoUrl = signed(asset.videoPath);
    urls.videoDownloadUrl = attach(asset.videoPath);
  }
  if (asset.proofPath !== undefined) urls.proofUrl = attach(asset.proofPath);
  if (asset.htmlFallbackPath !== undefined) urls.htmlFallbackUrl = signed(asset.htmlFallbackPath);
  // The bundle is signed under a FIXED name whatever its path is called, because it
  // is a directory index rather than one file among many.
  if (asset.htmlBundlePath !== undefined)
    urls.htmlBundleUrl = signed(asset.htmlBundlePath, "index.html");
  return urls;
};

/**
 * The campaign the shell should restore on mount, as the SERVER now holds it
 * (PT-5e, D173): the last-opened pointer, the campaign's own meta, and the
 * listing entry whose brief the restore takes. `cf:brief` is retired, so a test
 * that wants the shell holding a campaign seeds this instead of a localStorage
 * blob — which is also closer to what a real request sequence looks like.
 */
export interface OpenedCampaign {
  /** The campaign id (uuid or slug) every one of the three answers names. */
  readonly id: string;
  /** The stored brief the listing hands back for it. */
  readonly brief: unknown;
}

export type MockPipelineApiOptions = {
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
  /** The campaign the last-opened pointer names (absent = no pointer at all). */
  opened?: OpenedCampaign;
  /**
   * `GET /campaigns/last-opened` itself (PT-5e). The pointer is answered from
   * `opened` above, BEFORE any `result` handler runs — a per-test `result`
   * therefore never sees this URL, so a test that means "the pointer read
   * FAILED" (F6: could-not-ask is not absence) could not express it and its
   * assertion passed against a pointer that had in fact answered `null`. This
   * override is how such a test says so.
   */
  lastOpened?: GetFn;
};

/**
 * Seed the campaign the shell restores on mount, and return what was seeded —
 * for a test whose only fixture is the brief itself. A test that then re-mocks
 * the API to drive one route passes the return value back as `opened`, so the
 * campaign survives the re-mock.
 */
export const seedOpenedCampaign = (
  brief: { id: string } & Record<string, unknown>,
  opts: Omit<MockPipelineApiOptions, "opened"> = {},
): OpenedCampaign => {
  const opened = openedCampaign(brief);
  mockPipelineApi({ ...opts, opened });
  return opened;
};

/** What `mockPipelineApi` last resolved the campaign to, for a test that needs it. */
export const currentSeededCampaign = (): OpenedCampaign | undefined => seededCampaign;

/**
 * The server's answers for a campaign the shell restores on mount (PT-5e,
 * D173): the last-opened pointer, `GET /campaigns/:id`, and the listing entry
 * whose brief the restore takes. `cf:brief` is retired, so a test that wants the
 * shell holding a campaign passes this where it used to write a localStorage
 * blob — which is also closer to the request sequence a real page makes.
 */
export const openedCampaign = (
  brief: { id: string } & Record<string, unknown>,
): OpenedCampaign => ({
  id: brief.id,
  brief,
});

/**
 * Shared pipeline fetch router. Default POST is 202 `{ jobId }` (`job-1` unless
 * `jobId` is set); GET `${API}/campaigns/jobs/` is a completed snapshot of
 * `report` (empty job if omitted); any other GET returns `report` (or `EMPTY_REPORT`).
 *
 * `opened` adds the three campaign-addressed answers the bare pages and the
 * mount restore read (PT-5e): the pointer, `GET /campaigns/:id`, and the
 * listing. Without it the pointer answers "no pointer", so a page that did not
 * ask for a campaign takes the picker's path — which is what an unseeded test
 * wants.
 */
export const mockPipelineApi = (opts: MockPipelineApiOptions = {}) => {
  if (!vi.isMockFunction(globalThis.fetch)) vi.spyOn(globalThis, "fetch");
  const report = opts.report ?? EMPTY_REPORT;
  const opened = opts.opened ?? seededCampaign;
  if (opened) seededCampaign = opened;
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
    // The last-opened pointer (PT-5e). Matched on the exact path, before the
    // per-test `result` handler, so a test that routes some other URL cannot
    // accidentally answer the pointer with a body that parses as a campaign —
    // and `lastOpened` is how a test drives THIS url when `opened` cannot say
    // what it needs (a read that fails).
    if (u === `${API}/campaigns/last-opened`) {
      if (opts.lastOpened) return Promise.resolve(opts.lastOpened(u));
      return Promise.resolve(json({ campaignId: opened?.id ?? null }));
    }
    if (opened) {
      if (u === `${API}/campaigns/briefs`) {
        return Promise.resolve(
          json({
            briefs: [{ file: `${opened.id}.yaml`, campaignId: opened.id, brief: opened.brief }],
          }),
        );
      }
      if (u === `${API}/campaigns/${encodeURIComponent(opened.id)}`) {
        return Promise.resolve(
          json({
            campaignId: opened.id,
            slug: opened.id,
            name: null,
            type: null,
            hasVersion: true,
          }),
        );
      }
    }
    return Promise.resolve(opts.result ? opts.result(u) : json(report));
  });
};

/**
 * Seed a persisted run that RunProvider restores on mount: the server holds the
 * campaign (so the picker won't auto-open) and points at a report with `assets`.
 *
 * Since PT-5e the campaign is seeded as the server holds it — the last-opened
 * pointer plus that campaign's own brief — because `cf:brief`, the localStorage
 * copy of the whole brief this used to write, is retired (D173).
 */
export const seedPersistedRun = (
  assets: Asset[],
  opts: {
    halted?: boolean;
    id?: string;
    policyHash?: string;
    seed?: number;
    decisions?: Verdicts | ReturnType<typeof fakeDecisionsApi>;
    /**
     * Extra fields for the seeded campaign's stored brief (merged over the
     * default body) — the server's copy of a brief is an ordinary brief, so a
     * test that needs a particular `type` or `mode` says so here rather than
     * editing a localStorage blob that no longer exists.
     */
    brief?: Record<string, unknown>;
  } = {},
): OpenedCampaign => {
  const id = opts.id ?? "seed";
  // A classic brief never produces `variantIndex` assets, so a run carrying them must
  // sit under a randomized brief — otherwise the fixture models a state the app cannot
  // reach, and the re-roll mode guard (rightly) refuses it.
  const randomized = assets.some((asset) => asset.variantIndex !== undefined);
  localStorage.setItem("cf:brief-picked", "1");
  const opened: OpenedCampaign = {
    id,
    brief: {
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
      ...(opts.brief ?? {}),
    },
  };
  mockPipelineApi({
    report: {
      halted: opts.halted ?? false,
      assets,
      log: { entries: [], campaignId: id },
      ...(opts.policyHash !== undefined ? { policyHash: opts.policyHash } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    },
    opened,
    ...(opts.decisions !== undefined ? { decisions: opts.decisions } : {}),
  });
  // Returned so a test that re-mocks the API to drive one route (a re-roll's
  // job, a second campaign's report) can re-apply the same seeded campaign
  // instead of restating the brief.
  return opened;
};

interface NextControls {
  nav: { pathname: string };
  router: Record<string, Mock>;
  redirect: Mock;
}

/** The controllable next/navigation mocks exposed by vitest.setup.ts. */
export const nextMock = (): NextControls =>
  (globalThis as unknown as { __next: NextControls }).__next;
