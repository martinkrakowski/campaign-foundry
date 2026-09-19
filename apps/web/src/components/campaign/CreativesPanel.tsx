"use client";

import { useEffect, useState } from "react";
import type { PlanVariant } from "@/lib/briefs-api";
import { Accordion } from "@/components/shell/Accordion";
import { useVariationPlanResult } from "@/components/campaign/variation-plan";
import * as messages from "@/components/campaign/messages";

/** A planned creative that names a slot — the only kind that can be a row. */
export type PlannedCreative = PlanVariant & { readonly index: number };

/**
 * **The owner's 2a and 2b: the creatives, listed in the left sidebar, each one a
 * click away from being the creative the editor shows.**
 *
 * *"The creatives are listed in the left sidebar. Clicking through the various
 * creatives updates the editor to that instance of the creative."*
 *
 * **Read-only over occupancy (SL3).** This lists and selects. It does not add,
 * delete or edit — SL4 owns the gestures, under SL2's constraint that add
 * advances `nextIndex` only and delete appends a tombstone only. Nothing here
 * writes anything.
 *
 * **A tombstoned slot is not a row, and that is not a filter written here.**
 * `PlanVariationsUseCase` replays the whole allocation history so the survivors
 * stay byte-identical, and occupancy decides only what is *emitted*
 * (`PlanVariationsUseCase.use-case.ts:191-192`). `plan.variants` IS the emitted
 * set. The list shows what is emitted, so a deleted slot is absent by
 * construction — provided the request carried the occupancy, which is why the
 * test asserts the POST body as well as the rendered rows.
 *
 * **Keyed on `index`, guarded.** `planCampaign` does not validate the variants
 * array; it is an unchecked cast (`briefs-api.ts`). A variant with no numeric
 * index names no slot, so it is not a row — the alternative, keying on array
 * position, would mislabel every row after a hole.
 */
export function CreativesPanel({
  rows,
  selected,
  onSelect,
}: {
  readonly rows: readonly PlannedCreative[];
  readonly selected: number | null;
  readonly onSelect: (variant: PlannedCreative) => void;
}) {
  return (
    <div className="space-y-1.5" role="list" aria-label={messages.creativesLegend}>
      {rows.map((variant) => {
        const summary = messages.creativeRowSummary(variant);
        const isSelected = selected === variant.index;
        return (
          <div role="listitem" key={variant.index}>
            <button
              type="button"
              // `aria-pressed`, not `aria-selected`: these are toggles in a list,
              // not options in a listbox, and the row is a real button the whole
              // way across so the click target is the row.
              aria-pressed={isSelected}
              onClick={() => onSelect(variant)}
              className={`w-full rounded-lg border p-2 text-left transition-colors ${
                isSelected
                  ? "border-brand-primary bg-surface-2"
                  : "border-border-control bg-surface hover:border-border-control-hover"
              }`}
            >
              <div className="text-[12px] font-medium text-text-primary">
                {messages.creativeRowLabel(variant.index)}
              </div>
              {summary.length > 0 ? (
                <div className="truncate font-mono text-[10px] text-text-muted">{summary}</div>
              ) : null}
              {variant.headline !== undefined && variant.headline.length > 0 ? (
                <div className="truncate text-[11px] text-text-muted">{variant.headline}</div>
              ) : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The list as the sidebar wears it, and the reason the rows' STATE lives here
 * rather than in `BriefEditor`.
 *
 * This component renders inside the published panels — the sidebar's tree — so
 * the two things that move on every re-plan (the last-good rows, and keeping the
 * selection pointing at a creative that still exists) cost the editor no
 * commits. `BriefEditor` holds the selection itself, because the RAIL needs it
 * and the rail is published from there; it is written only by a click and by
 * this component's own reconciliation, never by a plan arriving.
 *
 * **No creatives, no chrome.** The accordion is inside the emptiness gate, not
 * around it: a heading over an empty box is the invisible-surface defect this
 * project keeps hitting, and a classic brief, a fresh draft, a refused plan and
 * a plan with no creatives in it must all show nothing at all.
 */
export function CreativesSection({
  selected,
  onSelect,
}: {
  readonly selected: PlannedCreative | null;
  readonly onSelect: (variant: PlannedCreative | null) => void;
}) {
  const plan = useVariationPlanResult();
  /**
   * The last plan that actually answered, held across a re-plan.
   *
   * `useVariationPlan` nulls while a request is in flight — correct for the
   * Estimate, which then says "Working out what you will get…". The LIST must
   * not do that: it would vanish on every keystroke and take the operator's
   * selected row with it. A plan that comes back infeasible or unavailable does
   * clear the rows, rather than offering creatives the planner has just said it
   * cannot produce.
   */
  const [rows, setRows] = useState<readonly PlannedCreative[]>([]);
  useEffect(() => {
    if (plan === null) return;
    setRows(
      plan.kind === "ok"
        ? plan.variants.filter((v): v is PlannedCreative => typeof v.index === "number")
        : [],
    );
  }, [plan]);

  /**
   * Keep the selection naming a creative that exists, and naming the CURRENT
   * draw of it.
   *
   * Two things a re-plan can do to a selected slot, and they need different
   * answers. It can drop the slot — the selection then names nothing, so it
   * retires (D139's rule for the layer pick, reached the same way). Or it can
   * keep the slot and redraw its axes, which happens whenever the operator edits
   * an axis while a row is selected: the row would show the new draw while the
   * rail still composed the old one, and the two surfaces would disagree about
   * the same creative. So the selection is re-pointed at the fresh object.
   *
   * Keyed on a fingerprint of the rows rather than the array, which is freshly
   * parsed from JSON on every answer; without it this would call upward on every
   * render of the sidebar.
   */
  const fingerprint = JSON.stringify(rows);
  const selectedFingerprint = JSON.stringify(selected);
  useEffect(() => {
    if (selected === null) return;
    const fresh = rows.find((variant) => variant.index === selected.index) ?? null;
    if (fresh === null) {
      onSelect(null);
      return;
    }
    if (JSON.stringify(fresh) !== selectedFingerprint) onSelect(fresh);
  }, [fingerprint, selectedFingerprint, onSelect]);

  if (rows.length === 0) return null;
  return (
    <Accordion title={messages.creativesLegend}>
      <CreativesPanel rows={rows} selected={selected?.index ?? null} onSelect={onSelect} />
    </Accordion>
  );
}
