"use client";

import type { EditorState } from "@/components/campaign/editor-state";
import { canPlan } from "@/components/campaign/editor-state";
import type { PlanResult, PlanVariant } from "@/lib/briefs-api";
import { useVariationPlanResult } from "@/components/campaign/variation-plan";
import { Eyebrow } from "@/components/ui";
import { ratioDisplayName } from "@/components/campaign/display-names";
import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { classicAdCount } from "@/components/campaign/derive";
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

/**
 * The estimate, both modes (D31). A Randomized draft asks the planner — the API's
 * per-axis plan — while a Classic draft is refused by that endpoint, so its
 * deliverables count is derived locally from products × ratios × treatments. The
 * planner's vocabulary never reaches the screen either way (D6).
 */
export function EstimatePanel({ state, plan }: { state: EditorState; plan: PlanResult | null }) {
  if (state.mode === "brief") {
    return <ClassicEstimate state={state} />;
  }
  return <VariationEstimate state={state} plan={plan} />;
}

/**
 * The panel as the sidebar mounts it: the same component, reading the editor's
 * one plan out of the provider it is published inside. The plan stays an
 * explicit prop on `EstimatePanel` so the component is still testable against a
 * plan a test hands it directly, rather than only against a fetch.
 */
export function EstimateFromPlan({ state }: { state: EditorState }) {
  return <EstimatePanel state={state} plan={useVariationPlanResult()} />;
}

/**
 * Classic: no planner endpoint exists (plan.post.ts refuses classic briefs), so the
 * count is derived in the editor and split evenly across the canonical ratios.
 */
function ClassicEstimate({ state }: { state: EditorState }) {
  const products = state.products.filter((product) => product.id.length > 0).length;
  // Products are what a classic count needs; treatments are optional, because the use
  // case substitutes DEFAULT_TREATMENT for an empty list. Gating on treatments hid the
  // estimate from a brief that runs perfectly well without any.
  const ready = products > 0;
  if (!ready) {
    return (
      <div className="rounded-lg border border-border bg-surface p-4">
        <Eyebrow as="h4">Estimate</Eyebrow>
        <p className="mt-2 text-[13px] text-text-muted">{messages.estimateNotReady}</p>
      </div>
    );
  }
  const sizeCount = state.sizes.length;
  const creatives = classicAdCount(products, state.treatments.length, sizeCount);
  const perCanvas = creatives / (RATIO_VALUES.length + sizeCount);
  const canvases = [
    ...RATIO_VALUES.map((ratio) => ({ label: ratioDisplayName(ratio), count: perCanvas })),
    // A requested display unit is a canvas the run will render too (D113) —
    // count it, or the sentence understates the deliverables it promises.
    ...state.sizes.map((size) => ({ label: size, count: perCanvas })),
  ];
  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <Eyebrow as="h4">Estimate</Eyebrow>
      <p className="mt-2 text-[13px] text-text-primary">
        {messages.estimateSentence({
          creatives,
          ratios: canvases,
          products,
          genaiCalls: 0,
        })}
      </p>
    </div>
  );
}

/**
 * Randomized: read the editor's one plan and degrade rather than hang on a failed
 * or unreachable endpoint. The estimate appears once the draft is plannable (canPlan).
 *
 * SL3 — the request itself moved to `useVariationPlan`, unchanged, because the
 * sidebar's creatives list reads the same answer and a second `/campaigns/plan`
 * per keystroke would be a cost regression. The host calls the hook once and
 * passes the result down; `ready` stays here because it is what tells "not
 * plannable yet" (`null` because there is nothing to ask) apart from "asking"
 * (`null` because a request is in flight), and the two say different sentences.
 */
function VariationEstimate({ state, plan }: { state: EditorState; plan: PlanResult | null }) {
  const ready = canPlan(state);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <Eyebrow as="h4">Estimate</Eyebrow>
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
            ...(plan.estimate.sceneBackgrounds === true ? { sceneBackgrounds: true as const } : {}),
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
