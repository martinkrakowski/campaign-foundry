"use client";

import { useEffect, useState } from "react";
import type { EditorState } from "@/components/campaign/editor-state";
import { canPlan, toBrief, PLAN_DEBOUNCE_MS } from "@/components/campaign/editor-state";
import { planCampaign, type PlanResult } from "@/lib/briefs-api";

export function EstimatePanel({ state }: { state: EditorState }) {
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const ready = canPlan(state);

  useEffect(() => {
    if (!ready) {
      setPlan(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setPlan(null);
    const timer = window.setTimeout(() => {
      void planCampaign(toBrief(state), controller.signal)
        .then((result) => {
          if (cancelled) return;
          setPlan(result);
        })
        .catch((err) => {
          if (cancelled) return;
          if (err.name !== "AbortError") setPlan(null);
        });
    }, PLAN_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    ready,
    state.briefId,
    state.mode,
    state.products,
    state.variation,
    state.targetRegion,
    state.targetAudience,
    state.campaignMessage,
    state.localizedMessage,
    state.platforms,
    state.pool,
    state.formats,
  ]);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h4 className="font-mono text-[11px] uppercase tracking-widest text-text-muted">Estimate</h4>
      {!ready ? (
        <p className="mt-2 text-[13px] text-text-muted">Fill required fields to estimate.</p>
      ) : plan === null ? (
        <p className="mt-2 text-[13px] text-text-muted">Estimating…</p>
      ) : plan.kind === "ok" ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] text-text-primary">
          <dt className="text-text-muted">creatives</dt>
          <dd>{plan.estimate.creatives}</dd>
          <dt className="text-text-muted">axisProductSize</dt>
          <dd>{plan.estimate.axisProductSize}</dd>
          <dt className="text-text-muted">feasible</dt>
          <dd>{plan.estimate.feasible ? "yes" : "no"}</dd>
          <dt className="text-text-muted">genaiCalls</dt>
          <dd>{plan.estimate.genaiCalls}</dd>
        </dl>
      ) : plan.kind === "infeasible" ? (
        <p className="mt-2 text-[13px] text-error">{plan.error}</p>
      ) : (
        <p className="mt-2 text-[13px] text-text-muted">estimate unavailable</p>
      )}
    </div>
  );
}
