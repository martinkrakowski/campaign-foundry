"use client";

import { useMemo } from "react";
import { assetKey, useRun } from "@/lib/run-context";
import { cn } from "@/lib/cn";

/**
 * Runs / history. The API currently persists only the latest run, so this shows
 * the current run summary. A true history list needs a backend runs endpoint +
 * per-run persistence (see the plan's follow-ups).
 */
export default function RunsPage() {
  const { brief, assets, halted, hasRun, loading, decisions } = useRun();

  const passed = useMemo(() => assets.filter((a) => a.passedCompliance).length, [assets]);
  const passRate = assets.length ? Math.round((passed / assets.length) * 100) : 0;
  const review = useMemo(() => {
    let approved = 0;
    let rejected = 0;
    for (const a of assets) {
      const d = decisions[assetKey(a)];
      if (d === "approved") approved += 1;
      else if (d === "rejected") rejected += 1;
    }
    return { approved, rejected, pending: assets.length - approved - rejected };
  }, [assets, decisions]);

  const status = loading ? "running" : halted ? "halted" : hasRun ? "complete" : "idle";

  return (
    <div className="flex h-full flex-col items-start p-4 pb-40 sm:p-8">
      <h2 className="mb-1 text-xl font-bold text-white">Runs</h2>
      <p className="mb-6 text-[13px] text-text-muted">Latest pipeline run (current session).</p>

      {!hasRun && !loading ? (
        <p className="text-text-muted">No runs yet. Execute the pipeline to see results here.</p>
      ) : (
        <div className="w-full max-w-3xl overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
          <div className="flex items-center justify-between border-b border-border p-4">
            <span className="font-mono text-[13px] text-text-primary">{brief.id}</span>
            <StatusBadge status={status} />
          </div>
          <dl className="grid grid-cols-3 divide-x divide-border text-center">
            <Stat label="Assets" value={String(assets.length)} />
            <Stat label="Passed compliance" value={`${passed}/${assets.length}`} />
            <Stat label="Pass rate" value={`${passRate}%`} />
          </dl>
          <dl className="grid grid-cols-3 divide-x divide-border border-t border-border text-center">
            <Stat label="Approved" value={String(review.approved)} />
            <Stat label="Rejected" value={String(review.rejected)} />
            <Stat label="Pending review" value={String(review.pending)} />
          </dl>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-4">
      <div className="text-2xl font-bold text-white">{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: "running" | "halted" | "complete" | "idle" }) {
  return (
    <span
      className={cn(
        "rounded border px-2 py-1 font-mono text-xs uppercase",
        status === "complete" && "border-success/30 bg-success/20 text-success",
        status === "halted" && "border-error/30 bg-error/20 text-error",
        status === "running" && "border-info/30 bg-info/20 text-info",
        status === "idle" && "border-border bg-surface-2 text-text-muted",
      )}
    >
      {status}
    </span>
  );
}
