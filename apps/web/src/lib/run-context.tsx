"use client";

import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  listPackages,
  packageCampaign,
  unknownErrorMessage,
  type PackagedPlatform,
  type PlanEstimate,
} from "./briefs-api";

/** Base path for the Nitro pipeline API (proxied by next.config rewrites). */
export const API = "/api/pipeline";

/** One rendered creative, as returned by the pipeline run report. */
export interface Asset {
  productId: string;
  aspectRatio: string;
  /** The PNG — the poster on motion assets. */
  outputPath: string;
  /** The mp4 — motion assets only. */
  videoPath?: string;
  /** Clip length in seconds — motion assets only. */
  durationSec?: number;
  proofPath?: string;
  complianceScore: number;
  passedCompliance: boolean;
  logoApplied: boolean;
  /** The creative treatment id (e.g. "default", "bold-bottom", "subtle-top"). */
  treatment: string;
  /** Background provenance: Firefly, Imagen, OpenRouter, the procedural fallback, or a reused asset. */
  backgroundSource: "firefly" | "imagen" | "openrouter" | "procedural" | "reused";
  variantIndex?: number;
  /** Re-roll counter. Variation originals are 0; omitted on classic assets. */
  attempt?: number;
  seed?: number;
  format?: "static" | "motion";
  /**
   * Planned axes for this slot — variation assets only.
   *
   * Every field is optional because this object arrives as untrusted JSON from a persisted
   * report, and declaring four of them required was a claim nothing verified. `normalizeDescriptor`
   * is what makes the shape true: it runs once at the boundary, keeps the fields that are
   * usable, and drops the rest. The optionality here is what forces a renderer to say what
   * it does when a field is absent, instead of rendering `undefined` into an empty chip.
   */
  descriptor?: {
    layout?: string;
    tone?: string;
    backgroundSource?: string;
    paletteShift?: number;
    motion?: string;
    durationSec?: number;
    /**
     * How many copy beats a sequenced clip carried. Absent means the legacy
     * single-message path — a different statement from a sequence of length zero.
     */
    beats?: number;
    /** The pooled headline this slot drew (`headline: pool://copy`); omitted otherwise. */
    headline?: string;
  };
}

export type LogLevel = "info" | "warn" | "error";

/** One telemetry line emitted by the pipeline as it progresses. */
export interface LogEntry {
  timestamp: string;
  stage: string;
  message: string;
  level: LogLevel;
}

/** Operational telemetry for a run (the serialized PipelineExecutionLog). */
export interface RunLog {
  campaignId: string;
  startedAt: string;
  completedAt?: string;
  totalOperations: number;
  entries: LogEntry[];
}

/** The result of a pipeline run (GET /campaigns/jobs/:id result, or GET /campaigns/result). */
export interface RunResult {
  halted: boolean;
  assets: Asset[];
  log?: RunLog | null;
  error?: string;
  policyHash?: string;
  seed?: number;
}

/** First poll delay; each subsequent wait grows by JOB_POLL_BACKOFF up to JOB_POLL_MAX_MS. */
const JOB_POLL_MS = 250;
const JOB_POLL_BACKOFF = 1.5;
const JOB_POLL_MAX_MS = 2_000;
/** Consecutive non-OK / non-JSON polls tolerated before giving up on a running job. */
const JOB_POLL_MAX_TRANSIENT = 5;

const LOST_JOB_MESSAGE =
  "Run was interrupted (the pipeline API restarted before it finished). Showing the last saved result; run again to regenerate.";

/** Sleep that resolves early (rejecting) when `signal` aborts, so a poller can't outlive its run. */
const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pipelineUnreachable(status: number, error?: string): Error {
  return new Error(
    error ??
      `Pipeline API unreachable (HTTP ${status}). Start the full stack with \`yarn dev\` from the repo root (it runs the API on :3001 alongside this UI).`,
  );
}

/**
 * The one "is there a real persisted run for this brief?" rule, shared by the mount
 * restore, setBrief, and lost-job recovery. A present `log` marks a real run (a halted,
 * log-only run counts); the API's "no run yet" default has assets:[] and log:null.
 * The report must belong to this campaign — never adopt another brief's creatives.
 */
/**
 * Keep the descriptor fields that are usable and drop the rest (never the asset).
 *
 * A persisted report is untrusted JSON: `PersistedAsset.descriptor` is deliberately typed
 * `unknown` on the API side because `isPersistedAsset` decides whether a row is a usable
 * ASSET and says nothing about its provenance. A row whose descriptor is partial or junk is
 * still a perfectly good creative, so this narrows the provenance and never rejects the row.
 *
 * Returning `undefined` when nothing survives is deliberate: a descriptor with no readable
 * field is indistinguishable from no descriptor, and a classic asset legitimately has none.
 */
export function normalizeDescriptor(value: unknown): Asset["descriptor"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  // An empty or whitespace-only string is not a usable field: it would satisfy the chip's
  // presence check and render the empty pill this whole function exists to prevent. The
  // filter options already treated it as absent (they test truthiness), so keeping it here
  // made the two disagree about the same descriptor.
  const str = (v: unknown): string | undefined => {
    if (typeof v !== "string") return undefined;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const descriptor: NonNullable<Asset["descriptor"]> = {
    ...(str(raw.layout) !== undefined ? { layout: str(raw.layout) } : {}),
    ...(str(raw.tone) !== undefined ? { tone: str(raw.tone) } : {}),
    ...(str(raw.backgroundSource) !== undefined ? { backgroundSource: str(raw.backgroundSource) } : {}),
    ...(num(raw.paletteShift) !== undefined ? { paletteShift: num(raw.paletteShift) } : {}),
    ...(str(raw.motion) !== undefined ? { motion: str(raw.motion) } : {}),
    ...(num(raw.durationSec) !== undefined ? { durationSec: num(raw.durationSec) } : {}),
    ...(num(raw.beats) !== undefined ? { beats: num(raw.beats) } : {}),
    ...(str(raw.headline) !== undefined ? { headline: str(raw.headline) } : {}),
  };
  return Object.keys(descriptor).length > 0 ? descriptor : undefined;
}

/** Narrow every asset's provenance once, where report JSON becomes a RunResult. */
export function normalizeRunResult(result: RunResult): RunResult {
  if (!Array.isArray(result.assets)) return result;
  return {
    ...result,
    assets: result.assets.map((asset) =>
      asset.descriptor === undefined
        ? asset
        : { ...asset, descriptor: normalizeDescriptor(asset.descriptor) },
    ),
  };
}

async function fetchPersistedRun(campaignId: string): Promise<RunResult | null> {
  try {
    const res = await fetch(`${API}/campaigns/result?campaignId=${encodeURIComponent(campaignId)}`);
    const d = (await res.json()) as RunResult;
    // The one place persisted JSON becomes a RunResult, so the one place to narrow it.
    if (d?.log?.campaignId === campaignId && (d.assets?.length || d.log)) return normalizeRunResult(d);
  } catch {
    /* non-JSON / network — treat as "no persisted run" */
  }
  return null;
}

type PollOutcome = { kind: "completed"; result: RunResult } | { kind: "lost" };

/**
 * Poll a job until it settles. A 404 means the in-memory job is gone (API restart or
 * TTL) — reported as `lost` so the caller decides what to show; it is never a result.
 * Transient poll failures (proxy blips, non-JSON pages) are retried up to
 * JOB_POLL_MAX_TRANSIENT times with backoff, because the server job keeps running.
 */
async function pollJob(jobId: string, signal: AbortSignal): Promise<PollOutcome> {
  let delay = JOB_POLL_MS;
  let transient = 0;
  for (;;) {
    const res = await fetch(`${API}/campaigns/jobs/${encodeURIComponent(jobId)}`, { signal });
    if (res.status === 404) return { kind: "lost" };
    const data = parseJson(await res.text());
    if (res.ok && data?.status === "failed") {
      throw new Error(typeof data.error === "string" ? data.error : "Generation failed");
    }
    if (res.ok && data?.status === "completed") {
      const result = data.result as RunResult | undefined;
      if (!result) throw new Error("Generation failed");
      return { kind: "completed", result };
    }
    if (!res.ok || !data) {
      transient += 1;
      if (transient >= JOB_POLL_MAX_TRANSIENT) {
        throw pipelineUnreachable(res.status, typeof data?.error === "string" ? data.error : undefined);
      }
    } else {
      transient = 0; // a well-formed "running" snapshot
    }
    await wait(delay, signal);
    delay = Math.min(delay * JOB_POLL_BACKOFF, JOB_POLL_MAX_MS);
  }
}

export type Decision = "approved" | "rejected";

export type EstimateStatus = "idle" | "loading" | "ok" | "infeasible" | "unavailable";

export type { PackagedPlatform, PlanEstimate };

/**
 * Stable key — classic triple, or `productId/v<index>` in variation mode.
 * Mirrors domain `assetIdentity` (same fixtures; a runtime re-export of the
 * package hits webpack's inability to map `.js` specifiers onto `.ts` sources).
 */
export const assetKey = (a: Pick<Asset, "productId" | "aspectRatio" | "treatment" | "variantIndex">): string =>
  a.variantIndex !== undefined ? `${a.productId}/v${a.variantIndex}` : `${a.productId}/${a.aspectRatio}/${a.treatment}`;

/** Human-readable label — includes `v<index>` in variation mode so duplicate layouts are distinct. */
export const assetLabel = (
  a: Pick<Asset, "productId" | "aspectRatio" | "treatment" | "variantIndex">,
): string =>
  a.variantIndex !== undefined
    ? `${a.productId} @ ${a.aspectRatio} · v${a.variantIndex} · ${a.treatment}`
    : `${a.productId} @ ${a.aspectRatio} · ${a.treatment}`;

/** Canvas raster + encode budget per frame (wave-4 perf spike), for the encode estimate. */
export const ENCODE_MS_PER_FRAME = 7;

/** Human-readable encode estimate for a frame count. */
export const encodeMinutes = (frames: number): string =>
  `≈ ${((frames * ENCODE_MS_PER_FRAME) / 60_000).toFixed(1)} min`;

/** localStorage key for persisted HITL approve/reject decisions. */
const DECISIONS_KEY = "cf:decisions";

/** localStorage flag: the brief picker has been shown/dismissed once (don't auto-open again). */
const BRIEF_PICKED_KEY = "cf:brief-picked";

/** localStorage key for the active brief, so a reload restores it (and its run) not DEFAULT. */
const BRIEF_KEY = "cf:brief";

/** Minimal shape guard for a brief restored from storage (don't trust hand-edited JSON). */
function isStoredBrief(value: unknown): value is CampaignBrief {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Partial<CampaignBrief>;
  return (
    typeof b.id === "string" &&
    b.id.length > 0 &&
    Array.isArray(b.products) &&
    b.products.length > 0 &&
    b.products.every(
      (p) => p && typeof p.id === "string" && typeof p.name === "string" && typeof p.primaryColor === "string",
    )
  );
}

/**
 * The brief the shell starts with. The HITL surface (the /brief view) edits a
 * copy of this; `execute()` sends whatever the current brief is.
 */
const DEFAULT_BRIEF: CampaignBrief = {
  id: "summer-hydration-2026",
  targetRegion: "DE",
  targetAudience: "Urban outdoor enthusiasts, 25-40",
  campaignMessage: "Stay wild. Stay hydrated.",
  localizedMessage: "Bleib wild. Bleib hydriert.",
  products: [
    { id: "hydra-bottle", name: "Hydra Bottle", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
    { id: "trail-pack", name: "Trail Pack", primaryColor: "#E0218A", logoPath: "assets/inputs/trail-logo.png" },
  ],
  // Two treatments so the HITL grid demonstrates the variation matrix out of the
  // box (each ratio slot rendered bold-bottom and subtle-top, side-by-side).
  treatments: [
    { id: "bold-bottom", layout: "headline-bottom", tone: "bold" },
    { id: "subtle-top", layout: "headline-top", tone: "subtle" },
  ],
};

interface RunContextValue {
  brief: CampaignBrief;
  setBrief: (brief: CampaignBrief) => void;
  /**
   * Whether the shell holds a campaign somebody has committed — applied (or saved &
   * applied) in the editor, loaded from `briefs/`, or chosen in the picker — rather
   * than one of the two states that mean nothing has been applied: the untouched
   * default this provider starts from, and the empty brief `/brief/new` releases
   * (`blankBrief()`, whose `id` is blank because nothing can be saved or run under it).
   *
   * Read-only, and derived here rather than lifted out of the editor: whether a draft
   * is applied is `EditorState.appliedSnapshot` (BriefEditor.tsx:300, a component the
   * shell does not contain), but every commit there already ends in `setBrief`, so the
   * brief the shell holds is the one signal the two agree on.
   */
  briefApplied: boolean;
  assets: Asset[];
  halted: boolean;
  log: LogEntry[];
  loading: boolean;
  error: string | null;
  hasRun: boolean;
  decisions: Record<string, Decision>;
  decide: (key: string, decision: Decision) => void;
  /**
   * Run the pipeline. With no argument the shell's active brief is POSTed, exactly as
   * always (the grid's Execute, the header's Generate over a committed brief). D35:
   * the editor's Generate asks to run *the on-screen draft* — a brief that may never
   * have been written to disk — so the brief to run is a parameter, not a closure over
   * `brief`. The run result still keys by the target's campaign id; the shell's brief
   * is untouched (run-without-write commits nothing).
   */
  execute: (override?: CampaignBrief) => Promise<void>;
  /**
   * Re-roll only the creatives currently marked rejected: regenerates those cells,
   * merges them back in, and returns them to review (clears their decisions). No-op
   * when nothing is rejected. Approved/pending creatives are left untouched. The
   * re-roll POSTs the brief the run actually ran — recorded beside its result —
   * never the shell's active brief, which a draft run leaves untouched (R6).
   */
  regenerateRejected: () => Promise<void>;
  /**
   * The mode the current run was produced under, read off its assets (a randomized
   * run carries `variantIndex`), or null with no run. A re-roll is only possible
   * when this matches the mode of the brief the run actually ran — the targets are
   * keyed differently otherwise.
   */
  runMode: "brief" | "variation" | null;
  /** Why a re-roll is impossible right now, or null. */
  rerollBlockedReason: string | null;
  /**
   * Keys being regenerated by the in-flight run, or null for a full run (all assets).
   * Lets the grid spin only the affected tiles during a selective re-roll.
   */
  regeneratingKeys: ReadonlySet<string> | null;
  /** Variation-plan hash, when the current run produced one. */
  policyHash?: string;
  /** Variation-plan seed, when the current run produced one. */
  seed?: number;
  /**
   * The campaign id the run on screen was produced under (null with no run) — the
   * report, its packages and its re-rolls all key by this, never by the shell
   * brief's id, which a "Run this draft" run never took on (R6).
   */
  ranCampaignId: string | null;
  /**
   * Bumped each time a run completes. Appended to creative image URLs as a cache
   * buster — runs overwrite the same output paths, so without it the browser
   * keeps serving the previous render.
   */
  assetVersion: number;
  /** Selected primary image model id (null = Auto / default chain). Sent with execute. */
  selectedModel: string | null;
  setSelectedModel: (model: string | null) => void;
  /**
   * Brief picker: lists the briefs in `briefs/` so a reviewer can load their own
   * spec instead of the built-in demo. Auto-opens once on first visit (then
   * remembered); reopenable from the sidebar.
   */
  briefPickerOpen: boolean;
  openBriefPicker: () => void;
  closeBriefPicker: () => void;
  /**
   * The telemetry drawer (W5.3). It is opened from the header, which is on every
   * route, and from the command bar on the grid — so like the brief picker, its state
   * lives here rather than in the layout that renders it. Non-modal: it changes no
   * draft, so opening it never asks the unsaved-changes guard anything.
   */
  telemetryOpen: boolean;
  toggleTelemetry: () => void;
  closeTelemetry: () => void;
  /** Last settled variation-plan estimate (CommandBar writes; Runs reads). */
  estimate: PlanEstimate | null;
  estimateError: string | null;
  estimateStatus: EstimateStatus;
  setEstimate: (next: {
    status: EstimateStatus;
    estimate?: PlanEstimate | null;
    error?: string | null;
  }) => void;
  packaging: boolean;
  packageError: string | null;
  packages: PackagedPlatform[];
  /**
   * Package the given platforms. `include` is the approved asset keys (the HITL
   * gate); omit it to package every asset of the run.
   */
  packageSelected: (platforms: readonly string[], include?: readonly string[]) => Promise<void>;
  loadPackages: () => Promise<void>;
}

const EMPTY_LOG: LogEntry[] = [];

/**
 * A committed run and the brief that produced it — always committed together. The
 * pairing is the fix for the re-roll-after-a-draft-run defect: `execute()` can run
 * an on-screen draft (D35) the shell does not hold, so "which campaign did these
 * assets come from?" is a property of the run, not of the shell. Carrying the target
 * on the same state (rather than a ref or a second state) makes it unrepresentable
 * to commit a result without naming its producer, and gives the re-roll guard and
 * every result-scoped action one consistent, reactive source to read.
 */
interface CommittedRun {
  result: RunResult;
  /** The brief this run POSTed — the shell's, or the draft "Run this draft" handed in. */
  target: CampaignBrief;
}

const RunContext = createContext<RunContextValue | null>(null);

export function RunProvider({ children }: { children: ReactNode }) {
  const [brief, setBriefState] = useState<CampaignBrief>(DEFAULT_BRIEF);
  const [run, setRun] = useState<CommittedRun | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assetVersion, setAssetVersion] = useState(0);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [regeneratingKeys, setRegeneratingKeys] = useState<ReadonlySet<string> | null>(null);
  const [briefPickerOpen, setBriefPickerOpen] = useState(false);
  const [telemetryOpen, setTelemetryOpen] = useState(false);
  const [estimate, setEstimateData] = useState<PlanEstimate | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [estimateStatus, setEstimateStatus] = useState<EstimateStatus>("idle");
  const [packaging, setPackaging] = useState(false);
  const [packageError, setPackageError] = useState<string | null>(null);
  const [packages, setPackages] = useState<PackagedPlatform[]>([]);

  // Brief picker: auto-open once on first visit so a reviewer sees they can load
  // their own spec; remember the dismissal so reloads don't re-prompt. Reopenable
  // from the sidebar.
  useEffect(() => {
    try {
      if (localStorage.getItem(BRIEF_PICKED_KEY) !== "1") setBriefPickerOpen(true);
    } catch {
      /* storage unavailable — just don't auto-open */
    }
  }, []);

  // Tracks the latest brief id asked for, so an in-flight persisted-run fetch from an
  // earlier switch can't land on the grid after the user has moved to another brief.
  const briefIdRef = useRef(brief.id);

  // Monotonic run token. Bumped when a run actually starts (beginRun, after the POST
  // answers with a job to poll) and when a brief switch invalidates any in-flight run;
  // execute()/regenerateRejected() capture it before awaiting and only commit their
  // results if it still matches — so a run that resolves after the user switched
  // briefs can't repopulate the grid with the previous brief's creatives.
  const runSeq = useRef(0);
  // The in-flight job poller. Starting a run (once the POST has answered), switching
  // briefs, or unmounting aborts it so an abandoned run never keeps hitting
  // /campaigns/jobs/:id in the background.
  const pollAbort = useRef<AbortController | null>(null);
  // Packaging shares the brief-identity guard: a package call captures brief.id and
  // drops its result if the user has moved on, or if a newer package call has already
  // completed (packageSeq). A brief switch aborts whatever is still in flight.
  const packageAbort = useRef<AbortController | null>(null);
  const packageSeq = useRef(0);
  const packageSignal = (): AbortSignal => {
    packageAbort.current ??= new AbortController();
    return packageAbort.current.signal;
  };
  /**
   * Mark a run as started: abort any previous poller, take a fresh token, and hand
   * back the signal the new poller must die on. Called only once the POST has
   * answered with a job to poll — never before, or a second Generate would abort
   * the poller of the run that is actually in flight and bury its result (C4).
   */
  const beginRun = (): { seq: number; signal: AbortSignal } => {
    pollAbort.current?.abort();
    const controller = new AbortController();
    pollAbort.current = controller;
    return { seq: (runSeq.current += 1), signal: controller.signal };
  };

  // Loading or committing a brief swaps which run the grid should show. Only ever called
  // as a deliberate commit — the editor's Save and the picker's select — never per
  // keystroke, so this won't wipe the grid mid-edit. Behaviour:
  //   1. If the run already on screen belongs to this brief, keep it (and its review
  //      decisions) — e.g. re-selecting the brief that's already loaded.
  //   2. Otherwise load the persisted run for this brief if one exists on disk, so
  //      previously generated creatives reappear without re-running the pipeline.
  //   3. Otherwise fall back to the empty "ready to run" state.
  const setBrief = useCallback(
    (next: CampaignBrief) => {
      briefIdRef.current = next.id;
      setBriefState(next);
      setError(null);
      // Remember the active brief so a reload restores it (and its run) instead of DEFAULT.
      // The blank brief clears the key instead: there is no campaign to come back to, and
      // leaving the previous one in storage is how a reload after "New brief" used to put
      // it back on screen.
      try {
        if (next.id) localStorage.setItem(BRIEF_KEY, JSON.stringify(next));
        else localStorage.removeItem(BRIEF_KEY);
      } catch {
        /* storage unavailable — brief just won't persist across reloads */
      }
      // (1) Already showing this brief's run — leave the grid (and decisions) intact.
      // The run's recorded target is left alone too: the run on screen was produced by
      // the brief as it was when it ran, and a re-roll must keep regenerating under
      // that — never under this newer same-id edit (R6).
      if (run?.result.log?.campaignId === next.id) return;
      setEstimateData(null);
      setEstimateError(null);
      setEstimateStatus("idle");
      setPackages([]);
      setPackageError(null);
      setPackaging(false);
      // Switching to a different brief invalidates any in-flight run and leaves the
      // "orchestrating" UI state, so a late-resolving run can't write back (the seq
      // guard in execute/regenerateRejected) and the grid isn't stuck spinning.
      runSeq.current += 1;
      pollAbort.current?.abort();
      packageAbort.current?.abort();
      packageAbort.current = null;
      setLoading(false);
      setRegeneratingKeys(null);
      // (2)/(3) Clear, then adopt this brief's own persisted run if one exists. The API
      // keys reports by campaign id, so we ask for exactly this brief's report — every
      // brief's run survives independently, not just the most recent. Empty → grid stays
      // in the "ready to run" state. The restored run's target is the brief being
      // loaded: it is the only producer we can honestly name for it.
      setRun(null);
      setDecisions({});
      void fetchPersistedRun(next.id).then((d) => {
        if (briefIdRef.current !== next.id || !d) return; // superseded, or no run on disk
        setRun({ result: d, target: next });
        if (d.assets?.length) setAssetVersion((v) => v + 1);
      });
    },
    [run],
  );

  // Derived, not stored: "applied" is a statement about the brief the shell holds, and
  // the two uncommitted states are exactly the two this provider can hand out before a
  // commit — the default it starts from, and the blank one the new-brief route sets.
  const briefApplied = brief !== DEFAULT_BRIEF && brief.id !== "";

  const toggleTelemetry = useCallback(() => setTelemetryOpen((open) => !open), []);
  const closeTelemetry = useCallback(() => setTelemetryOpen(false), []);

  const openBriefPicker = useCallback(() => setBriefPickerOpen(true), []);
  const closeBriefPicker = useCallback(() => {
    setBriefPickerOpen(false);
    try {
      localStorage.setItem(BRIEF_PICKED_KEY, "1");
    } catch {
      /* best-effort */
    }
  }, []);

  // On first load, restore the brief the user last had (DEFAULT if none) and hydrate
  // that brief's own persisted run — so a reload after a previous session brings back
  // the right brief and its creatives, not DEFAULT with an empty grid. The brief lives
  // in localStorage (the report alone can't reconstruct messages/colours/logos).
  useEffect(() => {
    let active = true;
    let startBrief = DEFAULT_BRIEF;
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(BRIEF_KEY) ?? "null");
      if (isStoredBrief(parsed)) startBrief = parsed;
    } catch {
      /* unreadable/malformed storage — start from DEFAULT_BRIEF */
    }
    if (startBrief !== DEFAULT_BRIEF) {
      briefIdRef.current = startBrief.id;
      setBriefState(startBrief);
    }
    // Restore any real persisted run for the starting brief (fetchPersistedRun applies
    // the shared "real run for this campaign" rule). Guard against a brief switch racing
    // this initial fetch. The restored run's target is the brief it is restored under.
    void fetchPersistedRun(startBrief.id).then((d) => {
      if (!active || briefIdRef.current !== startBrief.id || !d) return;
      setRun({ result: d, target: startBrief });
      if (d.assets?.length) setAssetVersion((v) => v + 1);
    });
    return () => {
      active = false;
      pollAbort.current?.abort(); // unmount: no poller may outlive the provider
    };
  }, []);

  // Persist approve/reject decisions across reloads: load (validated) once on mount,
  // save on change. (execute clears decisions for a fresh run, which the save effect
  // then flushes.) Best-effort — ignores private-mode/quota failures.
  const skipFirstDecisionsSave = useRef(true);

  useEffect(() => {
    try {
      // Validate before trusting storage: a stray "null"/array/primitive must not
      // become `decisions`, or consumers indexing decisions[key] would throw.
      const parsed: unknown = JSON.parse(localStorage.getItem(DECISIONS_KEY) ?? "null");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const restored: Record<string, Decision> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (value === "approved" || value === "rejected") restored[key] = value;
        }
        setDecisions(restored);
      }
    } catch {
      /* unreadable/malformed storage — start with no decisions */
    }
  }, []);

  useEffect(() => {
    // Skip the initial render so the empty starting state can't overwrite stored
    // decisions before the load effect's update commits.
    if (skipFirstDecisionsSave.current) {
      skipFirstDecisionsSave.current = false;
      return;
    }
    try {
      localStorage.setItem(DECISIONS_KEY, JSON.stringify(decisions));
    } catch {
      /* storage unavailable — decisions stay in-memory for the session */
    }
  }, [decisions]);

  // Shared POST to the generate endpoint. The body is either a bare brief (full run)
  // or a `{ brief, regenerateOnly }` envelope (selective re-roll). Resolves with the
  // job id to poll: a 202's fresh job, or — from a 409 "already in progress" — the
  // handle of the run that is actually in flight, so a second press adopts it instead
  // of discarding it (C4). Any other answer throws: a 409 without a handle is the
  // failure it honestly is (nothing was started, and there is nothing to adopt), and
  // a 2xx without a job id is an API/UI version mismatch. The pipeline API is reached
  // through a same-origin proxy; when it isn't running the proxy returns a non-JSON
  // 5xx, so parse defensively and surface an actionable message instead of a raw
  // "Unexpected token" JSON error.
  const postGenerate = useCallback(
    async (body: unknown): Promise<string> => {
      const url = selectedModel
        ? `${API}/campaigns/generate?model=${encodeURIComponent(selectedModel)}`
        : `${API}/campaigns/generate`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = parseJson(await res.text());
      const jobId = typeof data?.jobId === "string" ? data.jobId : undefined;
      if ((res.status === 202 || res.status === 409) && jobId) return jobId;
      if (res.ok) {
        // A 2xx that is not a job handle: an API that predates the job protocol.
        throw new Error(
          `Unexpected response from the pipeline API (HTTP ${res.status}, expected 202 with a job id) — the API and UI versions differ.`,
        );
      }
      throw pipelineUnreachable(res.status, typeof data?.error === "string" ? data.error : undefined);
    },
    [selectedModel],
  );

  const execute = useCallback(async (override?: CampaignBrief) => {
    // The brief this press runs: the shell's active brief by default, or the draft
    // handed in (Generate's "Run this draft" — the on-screen draft, which may never
    // have been saved). Everything below keys off the target, never off `brief`, so
    // a run cannot silently POST the previous campaign (R6).
    const target = override ?? brief;
    // The token this press owns while its POST is in flight — captured, not bumped:
    // beginRun() runs only once the POST has answered with a job to poll. Of two
    // presses racing, the first to get a job claims the run and the other drops out
    // silently here (its 409, when the server sent one, named the very job being
    // polled), so exactly one run is ever adopted and one result committed.
    let owned = runSeq.current;
    setLoading(true);
    setError(null);
    try {
      const jobId = await postGenerate(target);
      if (runSeq.current !== owned) return; // a brief switch (or newer run) superseded this press
      const started = beginRun();
      owned = started.seq;
      const outcome = await pollJob(jobId, started.signal);
      if (runSeq.current !== owned) return; // a brief switch (or newer run) superseded this
      if (outcome.kind === "lost") {
        // The job vanished mid-run. Whatever is on disk is the *previous* run, so show
        // it without pretending it is new: no cache-bust, review decisions kept. It
        // shares the target's campaign id, so the target is recorded unchanged.
        const persisted = await fetchPersistedRun(target.id);
        if (runSeq.current !== owned) return;
        if (persisted) setRun({ result: persisted, target });
        setError(LOST_JOB_MESSAGE);
        return;
      }
      // Commit the result beside the brief it actually ran — the draft handed in when
      // there was one, so every result-scoped action can key off it (R6).
      setRun({ result: outcome.result, target });
      setAssetVersion((v) => v + 1);
      setDecisions({});
      setError(null); // the result replaces any stale complaint about this run
    } catch (e) {
      if (runSeq.current !== owned) return;
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      if (runSeq.current === owned) setLoading(false);
    }
  }, [brief, postGenerate]);

  const runMode = useMemo<"brief" | "variation" | null>(() => {
    const assets = run?.result.assets ?? [];
    if (assets.length === 0) return null;
    return assets.some((a) => a.variantIndex !== undefined) ? "variation" : "brief";
  }, [run]);
  const rerollBlockedReason = useMemo(() => {
    // The re-roll POSTs the brief the run actually ran (the recorded target), so the
    // mode it must agree with is that brief's — not the shell's current brief, which
    // the user may have edited (or replaced with a draft) since the run (R6).
    const targetMode = run?.target.mode ?? "brief";
    if (runMode === null || runMode === targetMode) return null;
    return runMode === "brief"
      ? "These creatives came from a classic run, but the brief they were produced under is now a randomized campaign — the mode changed since that run, so they cannot be re-rolled. Run the full campaign."
      : "These creatives came from a randomized run, but the brief they were produced under is now a classic campaign — the mode changed since that run, so they cannot be re-rolled. Run the full campaign.";
  }, [runMode, run]);

  const regenerateRejected = useCallback(async () => {
    const current = run;
    const rejected = (current?.result.assets ?? []).filter((a) => decisions[assetKey(a)] === "rejected");
    if (current === null || rejected.length === 0) return;
    // The brief this run actually ran — an override draft when "Run this draft" was
    // used, the shell's brief otherwise. A re-roll regenerates the assets on screen,
    // so it must go out under exactly this brief; the shell's active brief is never
    // consulted (R6).
    const target = current.target;
    // Defence in depth: the command bar disables the control, but a stale render must
    // not be able to send targets keyed for the other mode.
    if (rerollBlockedReason !== null) {
      setError(rerollBlockedReason);
      return;
    }
    const targetKeys = new Set(rejected.map(assetKey));
    const targets = rejected.map((a) =>
      a.variantIndex !== undefined
        ? {
            productId: a.productId,
            variantIndex: a.variantIndex,
            attempt: (a.attempt ?? 0) + 1,
          }
        : { productId: a.productId, aspectRatio: a.aspectRatio, treatment: a.treatment },
    );

    // Same claim discipline as execute: the press's token is captured before the POST
    // and beginRun() runs only once the POST answers, so a re-roll can never abort
    // the poller of a run still in flight.
    let owned = runSeq.current;
    setRegeneratingKeys(targetKeys);
    setLoading(true);
    setError(null);
    try {
      const jobId = await postGenerate({ brief: target, regenerateOnly: targets });
      if (runSeq.current !== owned) return; // a brief switch (or newer run) superseded this press
      const started = beginRun();
      owned = started.seq;
      const outcome = await pollJob(jobId, started.signal);
      if (runSeq.current !== owned) return; // a brief switch (or newer run) superseded this
      if (outcome.kind === "lost") {
        // Nothing was regenerated that we can see: leave the grid and the rejected
        // decisions exactly as they were and say so.
        setError(LOST_JOB_MESSAGE);
        return;
      }
      const data = outcome.result;
      // The response carries only the regenerated cells — overlay them onto the
      // existing set by identity so approved/pending creatives are preserved. The
      // recorded target is unchanged: the re-roll ran under exactly that brief.
      setRun((prev) => {
        /* istanbul ignore next -- regenerate runs only with an existing run, so prev is non-null */
        if (prev === null) return prev;
        const byKey = new Map(prev.result.assets.map((a) => [assetKey(a), a] as const));
        for (const a of data.assets) byKey.set(assetKey(a), a);
        return {
          result: {
            halted: data.halted,
            assets: [...byKey.values()],
            log: data.log,
            policyHash: data.policyHash ?? prev.result.policyHash,
            seed: data.seed ?? prev.result.seed,
          },
          target: prev.target,
        };
      });
      setAssetVersion((v) => v + 1);
      setError(null); // the re-rolled grid replaces any stale complaint about this run
      // Regenerated creatives return to review: clear their (rejected) decisions.
      // The identity key is unchanged on a variation re-roll (productId/v<index>),
      // so the tile updates in place.
      setDecisions((prev) => {
        const next = { ...prev };
        for (const key of targetKeys) delete next[key];
        return next;
      });
    } catch (e) {
      if (runSeq.current !== owned) return;
      setError(e instanceof Error ? e.message : "Regeneration failed");
    } finally {
      if (runSeq.current === owned) {
        setLoading(false);
        setRegeneratingKeys(null);
      }
    }
  }, [rerollBlockedReason, run, decisions, postGenerate]);

  const decide = useCallback((key: string, decision: Decision) => {
    setDecisions((prev) => {
      const next = { ...prev };
      if (next[key] === decision) delete next[key];
      else next[key] = decision;
      return next;
    });
  }, []);

  const setEstimate = useCallback(
    (next: { status: EstimateStatus; estimate?: PlanEstimate | null; error?: string | null }) => {
      setEstimateStatus(next.status);
      if (next.status === "idle") {
        setEstimateData(null);
        setEstimateError(null);
        return;
      }
      if (next.estimate !== undefined) setEstimateData(next.estimate);
      if (next.error !== undefined) setEstimateError(next.error);
    },
    [],
  );

  const packageSelected = useCallback(
    async (platforms: readonly string[], include?: readonly string[]) => {
      const briefId = brief.id;
      // The package POST reads the run report by campaign id, so it must name the
      // campaign the on-screen run actually ran — a "Run this draft" run is keyed by
      // the draft's id, which the shell's brief never took on (R6).
      const campaignId = run?.target.id ?? briefId;
      const seq = packageSeq.current;
      setPackaging(true);
      setPackageError(null);
      try {
        const result = await packageCampaign(campaignId, platforms, { include, signal: packageSignal() });
        if (briefIdRef.current !== briefId || packageSeq.current !== seq) return; // superseded
        packageSeq.current += 1;
        setPackages((prev) => {
          const byId = new Map(prev.map((p) => [p.platformId, p] as const));
          for (const p of result.platforms) byId.set(p.platformId, p);
          return [...byId.values()];
        });
      } catch (e) {
        if (briefIdRef.current !== briefId) return; // aborted by a brief switch
        setPackageError(unknownErrorMessage(e, "Packaging failed"));
      } finally {
        if (briefIdRef.current === briefId) setPackaging(false);
      }
    },
    [brief.id, run],
  );

  const loadPackages = useCallback(async () => {
    const briefId = brief.id;
    // Same result-scoping as packageSelected: the manifests live under the campaign
    // id the on-screen run ran under, not the shell's current brief (R6).
    const campaignId = run?.target.id ?? briefId;
    const seq = packageSeq.current;
    try {
      const result = await listPackages(campaignId, packageSignal());
      // A listing that resolves after a brief switch, or after a package call completed
      // in the meantime, is stale — the fresher state already on screen wins.
      if (briefIdRef.current !== briefId || packageSeq.current !== seq) return;
      setPackages(result.platforms);
      setPackageError(null);
    } catch (e) {
      if (briefIdRef.current !== briefId) return; // aborted by a brief switch
      setPackageError(unknownErrorMessage(e, "Failed to list packages"));
    }
  }, [brief.id, run]);

  const value = useMemo<RunContextValue>(
    () => ({
      brief,
      setBrief,
      briefApplied,
      assets: run?.result.assets ?? [],
      halted: run?.result.halted ?? false,
      log: run?.result.log?.entries ?? EMPTY_LOG,
      loading,
      error,
      hasRun: run !== null,
      decisions,
      decide,
      execute,
      regenerateRejected,
      runMode,
      rerollBlockedReason,
      regeneratingKeys,
      policyHash: run?.result.policyHash,
      seed: run?.result.seed,
      ranCampaignId: run?.target.id ?? null,
      assetVersion,
      selectedModel,
      setSelectedModel,
      briefPickerOpen,
      openBriefPicker,
      closeBriefPicker,
      telemetryOpen,
      toggleTelemetry,
      closeTelemetry,
      estimate,
      estimateError,
      estimateStatus,
      setEstimate,
      packaging,
      packageError,
      packages,
      packageSelected,
      loadPackages,
    }),
    [
      brief,
      setBrief,
      briefApplied,
      run,
      loading,
      error,
      decisions,
      decide,
      execute,
      regenerateRejected,
      runMode,
      rerollBlockedReason,
      regeneratingKeys,
      assetVersion,
      selectedModel,
      setSelectedModel,
      briefPickerOpen,
      openBriefPicker,
      closeBriefPicker,
      telemetryOpen,
      toggleTelemetry,
      closeTelemetry,
      estimate,
      estimateError,
      estimateStatus,
      setEstimate,
      packaging,
      packageError,
      packages,
      packageSelected,
      loadPackages,
    ],
  );

  return <RunContext.Provider value={value}>{children}</RunContext.Provider>;
}

/** Access the shared pipeline-run state. Must be used within <RunProvider>. */
export function useRun(): RunContextValue {
  const ctx = useContext(RunContext);
  if (!ctx) throw new Error("useRun must be used within a RunProvider");
  return ctx;
}
