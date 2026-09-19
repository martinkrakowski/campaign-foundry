"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { EditorState } from "@/components/campaign/editor-state";
import { canPlan, toBrief, PLAN_DEBOUNCE_MS } from "@/components/campaign/editor-state";
import { planCampaign, type PlanResult } from "@/lib/briefs-api";

/**
 * **The editor's ONE `/campaigns/plan` request.**
 *
 * This is `VariationEstimate`'s effect, lifted verbatim — same dependency list,
 * same debounce, same degradation (an abort is this effect cleaning up after
 * itself; anything else mirrors `planCampaign`'s own `unavailable` rather than
 * leaving `null`, which would render "Estimating…" forever).
 *
 * **Why it had to leave the panel.** SL3 adds a second reader of the same answer:
 * the sidebar's creatives list is a row per `plan.variants` entry. A second
 * `planCampaign` call would be a plain cost regression on every keystroke, and
 * the editor has an explicit contract about that class of call — a
 * look-preserving keystroke issues zero `/preview-frame` calls (`rail-in-shell`,
 * `brief-editor`). Planning is cheaper than a frame; the principle is the same.
 * So one caller, `VariationPlanProvider`, and both surfaces read it.
 *
 * **Why the provider is PUBLISHED rather than written in `BriefEditor`'s own
 * JSX — measured, not preferred.** The obvious shape is for the editor to call
 * this hook and pass `plan` down as a prop. It costs the editor its cost
 * contract: this effect nulls on a dependency change and sets again when the
 * request lands, and `state.targetAudience` is in the list — so with the state
 * in `BriefEditor`, one look-preserving keystroke became **four** editor renders
 * where the contract says exactly one (`rail-in-shell.test.tsx` (3b), and X30's
 * three-keystroke commit count in `brief-editor.test.tsx`: 3 became 6). Both
 * failed on the first full run of this lane. The panels are published through
 * `EditorPanelsContext` and RENDER in the sidebar's tree, so a provider that
 * travels INSIDE the published element is above the two consumers and below
 * nothing the editor re-renders for — exactly where the state used to live when
 * it was `EstimatePanel`'s own.
 *
 * **Why not `CommandBar`'s plan**, which the lane brief pointed at. `CommandBar`
 * (`CommandBar.tsx:83`) plans the run-context brief — the COMMITTED one. The
 * list must show the creatives of the draft on screen, occupancy included, or an
 * operator who edited an axis would be clicking rows from the saved brief. This
 * hook plans `toBrief(state)`, which is what Save sends.
 *
 * Returns `null` while nothing is plannable and while a re-plan is in flight;
 * callers that must not flicker hold their own last-good value.
 */
export function useVariationPlan(state: EditorState): PlanResult | null {
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

  return plan;
}

/**
 * `undefined` distinguishes "no provider above me" from the provider's own
 * `null` ("nothing plannable, or a request in flight"), so a consumer mounted
 * outside the provider throws instead of silently reading a plan that never
 * arrives — the same reason `EditorPanelsContext` throws rather than defaulting.
 */
const VariationPlanContext = createContext<PlanResult | null | undefined>(undefined);

/**
 * The editor's one planner call, placed where its state changes cost the editor
 * nothing: this element travels inside what `BriefEditor` publishes through
 * `setPanels`, so it renders in the sidebar's tree. See `useVariationPlan` for
 * the measurement that put it here.
 */
export function VariationPlanProvider({
  state,
  children,
}: {
  readonly state: EditorState;
  readonly children: ReactNode;
}) {
  const plan = useVariationPlan(state);
  return <VariationPlanContext.Provider value={plan}>{children}</VariationPlanContext.Provider>;
}

/** The plan both sidebar surfaces read. Throws outside the provider. */
export function useVariationPlanResult(): PlanResult | null {
  const plan = useContext(VariationPlanContext);
  if (plan === undefined) {
    throw new Error("useVariationPlanResult must be used within a VariationPlanProvider");
  }
  return plan;
}
