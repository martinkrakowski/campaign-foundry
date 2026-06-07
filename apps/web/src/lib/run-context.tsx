"use client";

import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** Base path for the Nitro pipeline API (proxied by next.config rewrites). */
export const API = "/api/pipeline";

/** One rendered creative, as returned by the pipeline run report. */
export interface Asset {
  productId: string;
  aspectRatio: string;
  outputPath: string;
  proofPath?: string;
  complianceScore: number;
  passedCompliance: boolean;
  logoApplied: boolean;
  /** The creative treatment id (e.g. "default", "bold-bottom", "subtle-top"). */
  treatment: string;
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

/** The result of a pipeline run (POST /campaigns/generate or GET /campaigns/result). */
export interface RunResult {
  halted: boolean;
  assets: Asset[];
  log?: RunLog | null;
  error?: string;
}

export type Decision = "approved" | "rejected";

/** Stable key for an asset across its product × aspect-ratio × treatment identity. */
export const assetKey = (a: Asset): string => `${a.productId}/${a.aspectRatio}/${a.treatment}`;

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
    { id: "acme-hydra-bottle", name: "Hydra Bottle", primaryColor: "#1473E6", logoPath: "assets/inputs/hydra-logo.png" },
    { id: "acme-trail-pack", name: "Trail Pack", primaryColor: "#E0218A", logoPath: "assets/inputs/trail-logo.png" },
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
}

const EMPTY_LOG: LogEntry[] = [];

const RunContext = createContext<RunContextValue | null>(null);

export function RunProvider({ children }: { children: ReactNode }) {
  const [brief, setBrief] = useState<CampaignBrief>(DEFAULT_BRIEF);
  const [result, setResult] = useState<RunResult | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate from the last persisted run so views aren't empty on first load.
  useEffect(() => {
    let active = true;
    fetch(`${API}/campaigns/result`)
      .then((r) => r.json() as Promise<RunResult>)
      .then((d) => {
        if (active && d.assets?.length) setResult(d);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const execute = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/campaigns/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(brief),
      });
      // The pipeline API is reached through a same-origin proxy; when it isn't
      // running the proxy returns a non-JSON 5xx, so parse defensively and surface
      // an actionable message instead of a raw "Unexpected token" JSON error.
      const raw = await res.text();
      let data: RunResult | null = null;
      try {
        data = JSON.parse(raw) as RunResult;
      } catch {
        data = null;
      }
      if (!res.ok || !data) {
        throw new Error(
          data?.error ??
            `Pipeline API unreachable (HTTP ${res.status}). Start the full stack with \`yarn dev\` from the repo root (it runs the API on :3001 alongside this UI).`,
        );
      }
      setResult(data);
      setDecisions({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setLoading(false);
    }
  }, [brief]);

  const decide = useCallback((key: string, decision: Decision) => {
    setDecisions((prev) => {
      const next = { ...prev };
      if (next[key] === decision) delete next[key];
      else next[key] = decision;
      return next;
    });
  }, []);

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
    }),
    [brief, result, loading, error, decisions, decide, execute],
  );

  return <RunContext.Provider value={value}>{children}</RunContext.Provider>;
}

/** Access the shared pipeline-run state. Must be used within <RunProvider>. */
export function useRun(): RunContextValue {
  const ctx = useContext(RunContext);
  if (!ctx) throw new Error("useRun must be used within a RunProvider");
  return ctx;
}
