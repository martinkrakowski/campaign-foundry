"use client";

import { useMemo } from "react";
import { assetKey, assetLabel, encodeMinutes, useRun } from "@/lib/run-context";
import { MiniChip } from "@/components/ui";

/**
 * Runs / history. The API currently persists only the latest run, so this shows
 * the current run summary. A true history list needs a backend runs endpoint +
 * per-run persistence (see the plan's follow-ups).
 */
export default function RunsPage() {
  const { brief, assets, halted, hasRun, loading, decisions, policyHash, seed, estimate, estimateStatus, estimateError } =
    useRun();

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
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col p-4 pb-12 sm:p-8">
      <h2 className="mb-1 text-lg font-semibold text-text-emphasis">Runs</h2>
      <p className="mb-6 text-[13px] text-text-muted">Latest pipeline run (current session).</p>

      {!hasRun && !loading ? (
        <p className="text-text-muted">No runs yet. Execute the pipeline to see results here.</p>
      ) : (
        <div className="w-full overflow-hidden rounded-xl border border-border bg-surface shadow-2xl">
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
          {(policyHash !== undefined || seed !== undefined) && (
            <dl className="grid grid-cols-2 divide-x divide-border border-t border-border text-center">
              {policyHash !== undefined && <Stat label="Policy hash" value={policyHash} />}
              {seed !== undefined && <Stat label="Seed" value={String(seed)} />}
            </dl>
          )}
          {estimateStatus === "ok" && estimate && (
            <dl className="grid grid-cols-2 divide-x divide-border border-t border-border text-center sm:grid-cols-4">
              <Stat label="Creatives" value={String(estimate.creatives)} />
              <Stat label="axisProductSize" value={String(estimate.axisProductSize)} />
              <Stat label="Feasible" value={estimate.feasible ? "yes" : "no"} />
              <Stat label="genaiCalls" value={String(estimate.genaiCalls)} />
            </dl>
          )}
          {estimateStatus === "ok" && estimate?.frames !== undefined && (
            <dl className="grid grid-cols-2 divide-x divide-border border-t border-border text-center">
              <Stat label="Frames" value={String(estimate.frames)} />
              <Stat label="Encode" value={encodeMinutes(estimate.frames)} />
            </dl>
          )}
          {estimateStatus === "loading" && (
            <p className="border-t border-border px-4 py-3 text-[13px] text-text-muted">estimating…</p>
          )}
          {estimateStatus === "infeasible" && estimateError && (
            <p className="border-t border-border px-4 py-3 text-[13px] text-error">{estimateError}</p>
          )}
          {assets.length > 0 && (
            <ul className="divide-y divide-border border-t border-border">
              {assets.map((asset) => (
                <li key={assetKey(asset)} className="truncate px-4 py-2 font-mono text-[12px] text-text-muted">
                  {assetLabel(asset)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-4">
      <div className="text-2xl font-bold text-text-emphasis">{value}</div>
      <div className="mt-1 text-[11px] uppercase tracking-wide text-text-muted">{label}</div>
    </div>
  );
}

const STATUS_TONES = {
  complete: "success",
  halted: "error",
  running: "info",
  idle: "neutral",
} as const;

function StatusBadge({ status }: { status: "running" | "halted" | "complete" | "idle" }) {
  return <MiniChip tone={STATUS_TONES[status]}>{status}</MiniChip>;
}
