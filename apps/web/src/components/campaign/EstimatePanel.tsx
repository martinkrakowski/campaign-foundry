"use client";

import { useEffect, useState } from "react";
import type { EditorState } from "@/components/campaign/editor-state";
import { canPlan, toBrief, PLAN_DEBOUNCE_MS } from "@/components/campaign/editor-state";
import { planCampaign, type PlanResult, type PlanVariant } from "@/lib/briefs-api";
import { ratioDisplayName } from "@/components/campaign/display-names";
import * as messages from "@/components/campaign/messages";

/**
 * How the plan's creatives fall across the aspect ratios, in the order the planner
 * emitted them. A variant without a ratio simply does not count towards the split —
 * the total still comes from the estimate, so the sentence cannot disagree with it.
 */
function ratioSplit(variants: readonly PlanVariant[]): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const variant of variants) {
    if (variant.aspectRatio === undefined) continue;
    counts.set(variant.aspectRatio, (counts.get(variant.aspectRatio) ?? 0) + 1);
  }
  return [...counts].map(([ratio, count]) => ({ label: ratioDisplayName(ratio), count }));
}

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
        .catch((err: unknown) => {
          if (cancelled) return;
          // An abort is this effect cleaning up after itself, not a failure.
          if (err instanceof Error && err.name === "AbortError") return;
          // Mirror planCampaign's own degradation. setPlan(null) would render
          // "Estimating…" forever — the very symptom this catch exists to prevent.
          setPlan({ kind: "unavailable" });
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
    state.motion,
    state.duration,
  ]);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h4 className="font-mono text-[11px] uppercase tracking-widest text-text-muted">Estimate</h4>
      {!ready ? (
        <p className="mt-2 text-[13px] text-text-muted">{messages.estimateNotReady}</p>
      ) : plan === null ? (
        <p className="mt-2 text-[13px] text-text-muted">{messages.estimateWorking}</p>
      ) : plan.kind === "ok" ? (
        <p className="mt-2 text-[13px] text-text-primary">
          {messages.estimateSentence({
            creatives: plan.estimate.creatives,
            ratios: ratioSplit(plan.variants),
            products: state.products.length,
            genaiCalls: plan.estimate.genaiCalls,
          })}
        </p>
      ) : plan.kind === "infeasible" ? (
        <p className="mt-2 text-[13px] text-error">{plan.error}</p>
      ) : (
        <p className="mt-2 text-[13px] text-text-muted">{messages.estimateUnavailable}</p>
      )}
    </div>
  );
}
