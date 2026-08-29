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
  assets: Asset[];
  halted: boolean;
  log: LogEntry[];
  loading: boolean;
  error: string | null;
  hasRun: boolean;
  decisions: Record<string, Decision>;
  decide: (key: string, decision: Decision) => void;
  execute: () => Promise<void>;
  /**
   * Re-roll only the creatives currently marked rejected: regenerates those cells,
   * merges them back in, and returns them to review (clears their decisions). No-op
   * when nothing is rejected. Approved/pending creatives are left untouched.
   */
  regenerateRejected: () => Promise<void>;
  /**
   * The mode the current run was produced under, read off its assets (a randomized
   * run carries `variantIndex`), or null with no run. A re-roll is only possible
   * when this matches the brief's mode — the targets are keyed differently otherwise.
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

const RunContext = createContext<RunContextValue | null>(null);

export function RunProvider({ children }: { children: ReactNode }) {
  const [brief, setBriefState] = useState<CampaignBrief>(DEFAULT_BRIEF);
  const [result, setResult] = useState<RunResult | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [assetVersion, setAssetVersion] = useState(0);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [regeneratingKeys, setRegeneratingKeys] = useState<ReadonlySet<string> | null>(null);
  const [briefPickerOpen, setBriefPickerOpen] = useState(false);
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

  // Monotonic run token. Bumped when a run starts and when a brief switch invalidates
  // any in-flight run; execute()/regenerateRejected() capture it before awaiting and
  // only commit their results if it still matches — so a run that resolves after the
  // user switched briefs can't repopulate the grid with the previous brief's creatives.
  const runSeq = useRef(0);
  // The in-flight job poller. Starting a run, switching briefs, or unmounting aborts it
  // so an abandoned run never keeps hitting /campaigns/jobs/:id in the background.
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
      if (result?.log?.campaignId === next.id) return;
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
      // in the "ready to run" state.
      setResult(null);
      setDecisions({});
      void fetchPersistedRun(next.id).then((d) => {
        if (briefIdRef.current !== next.id || !d) return; // superseded, or no run on disk
        setResult(d);
        if (d.assets?.length) setAssetVersion((v) => v + 1);
      });
    },
    [result],
  );

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
    // this initial fetch.
    void fetchPersistedRun(startBrief.id).then((d) => {
      if (!active || briefIdRef.current !== startBrief.id || !d) return;
      setResult(d);
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
  // or a `{ brief, regenerateOnly }` envelope (selective re-roll). A 202 `{ jobId }`
  // is polled until the job completes or fails; a 404 on the job recovers from the
  // persisted report. The pipeline API is reached through a same-origin proxy; when
  // it isn't running the proxy returns a non-JSON 5xx, so parse defensively and
  // surface an actionable message instead of a raw "Unexpected token" JSON error.
  const postGenerate = useCallback(
    async (body: unknown, signal: AbortSignal): Promise<PollOutcome> => {
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
      if (res.status === 202 && jobId) return pollJob(jobId, signal);
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

  const execute = useCallback(async () => {
    const { seq, signal } = beginRun();
    setLoading(true);
    setError(null);
    try {
      const outcome = await postGenerate(brief, signal);
      if (runSeq.current !== seq) return; // a brief switch (or newer run) superseded this
      if (outcome.kind === "lost") {
        // The job vanished mid-run. Whatever is on disk is the *previous* run, so show
        // it without pretending it is new: no cache-bust, review decisions kept.
        const persisted = await fetchPersistedRun(brief.id);
        if (runSeq.current !== seq) return;
        if (persisted) setResult(persisted);
        setError(LOST_JOB_MESSAGE);
        return;
      }
      setResult(outcome.result);
      setAssetVersion((v) => v + 1);
      setDecisions({});
    } catch (e) {
      if (runSeq.current !== seq) return;
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      if (runSeq.current === seq) setLoading(false);
    }
  }, [brief, postGenerate]);

  const runMode = useMemo<"brief" | "variation" | null>(() => {
    const assets = result?.assets ?? [];
    if (assets.length === 0) return null;
    return assets.some((a) => a.variantIndex !== undefined) ? "variation" : "brief";
  }, [result]);
  const rerollBlockedReason = useMemo(() => {
    const briefMode = brief.mode ?? "brief";
    if (runMode === null || runMode === briefMode) return null;
    return runMode === "brief"
      ? "These creatives came from a classic run, but the brief is now a randomized campaign — the mode changed since that run, so they cannot be re-rolled. Run the full campaign."
      : "These creatives came from a randomized run, but the brief is now a classic campaign — the mode changed since that run, so they cannot be re-rolled. Run the full campaign.";
  }, [runMode, brief.mode]);

  const regenerateRejected = useCallback(async () => {
    const rejected = (result?.assets ?? []).filter((a) => decisions[assetKey(a)] === "rejected");
    if (rejected.length === 0) return;
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

    const { seq, signal } = beginRun();
    setRegeneratingKeys(targetKeys);
    setLoading(true);
    setError(null);
    try {
      const outcome = await postGenerate({ brief, regenerateOnly: targets }, signal);
      if (runSeq.current !== seq) return; // a brief switch (or newer run) superseded this
      if (outcome.kind === "lost") {
        // Nothing was regenerated that we can see: leave the grid and the rejected
        // decisions exactly as they were and say so.
        setError(LOST_JOB_MESSAGE);
        return;
      }
      const data = outcome.result;
      // The response carries only the regenerated cells — overlay them onto the
      // existing set by identity so approved/pending creatives are preserved.
      setResult((prev) => {
        /* istanbul ignore next -- regenerate runs only with an existing run, so prev is non-null */
        const existing = prev?.assets ?? [];
        const byKey = new Map(existing.map((a) => [assetKey(a), a] as const));
        for (const a of data.assets) byKey.set(assetKey(a), a);
        return {
          halted: data.halted,
          assets: [...byKey.values()],
          log: data.log,
          policyHash: data.policyHash ?? prev?.policyHash,
          seed: data.seed ?? prev?.seed,
        };
      });
      setAssetVersion((v) => v + 1);
      // Regenerated creatives return to review: clear their (rejected) decisions.
      // The identity key is unchanged on a variation re-roll (productId/v<index>),
      // so the tile updates in place.
      setDecisions((prev) => {
        const next = { ...prev };
        for (const key of targetKeys) delete next[key];
        return next;
      });
    } catch (e) {
      if (runSeq.current !== seq) return;
      setError(e instanceof Error ? e.message : "Regeneration failed");
    } finally {
      if (runSeq.current === seq) {
        setLoading(false);
        setRegeneratingKeys(null);
      }
    }
  }, [rerollBlockedReason, brief, decisions, result, postGenerate]);

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
      const seq = packageSeq.current;
      setPackaging(true);
      setPackageError(null);
      try {
        const result = await packageCampaign(briefId, platforms, { include, signal: packageSignal() });
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
    [brief.id],
  );

  const loadPackages = useCallback(async () => {
    const briefId = brief.id;
    const seq = packageSeq.current;
    try {
      const result = await listPackages(briefId, packageSignal());
      // A listing that resolves after a brief switch, or after a package call completed
      // in the meantime, is stale — the fresher state already on screen wins.
      if (briefIdRef.current !== briefId || packageSeq.current !== seq) return;
      setPackages(result.platforms);
      setPackageError(null);
    } catch (e) {
      if (briefIdRef.current !== briefId) return; // aborted by a brief switch
      setPackageError(unknownErrorMessage(e, "Failed to list packages"));
    }
  }, [brief.id]);

  const value = useMemo<RunContextValue>(
    () => ({
      brief,
      setBrief,
      assets: result?.assets ?? [],
      halted: result?.halted ?? false,
      log: result?.log?.entries ?? EMPTY_LOG,
      loading,
      error,
      hasRun: result !== null,
      decisions,
      decide,
      execute,
      regenerateRejected,
      runMode,
      rerollBlockedReason,
      regeneratingKeys,
      policyHash: result?.policyHash,
      seed: result?.seed,
      assetVersion,
      selectedModel,
      setSelectedModel,
      briefPickerOpen,
      openBriefPicker,
      closeBriefPicker,
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
      result,
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
      briefPickerOpen,
      openBriefPicker,
      closeBriefPicker,
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
