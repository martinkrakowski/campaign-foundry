"use client";

import { AxisCard, RatioFrame } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { AspectRatioValue } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";

/** One canvas of the ratio axis: its value and the pixels the compositor renders. */
export interface RatioCanvas {
  readonly value: AspectRatioValue;
  readonly width: number;
  readonly height: number;
}

export interface RatioPanelProps {
  /** The canvas — its value is the accessible name, its dimensions the pixel spec. */
  readonly ratio: RatioCanvas;
  readonly selected: boolean;
  /** True when the motion narrowing excludes this ratio from a motion-only plan. */
  readonly excluded: boolean;
  /** Why the ratio is excluded — the same string on every excluded panel. */
  readonly reason: string | undefined;
  /** How many of `count` this ratio is projected to receive (0 when it is not drawn). */
  readonly allocation: number;
  readonly count: number;
  /** The shared per-ratio floor — one setting, displayed identically on every panel. */
  readonly floor: number;
  readonly onToggle: (value: string) => void;
}

/**
 * One selectable aspect ratio, built on AxisCard (which carries the pressed
 * state, the selected treatment and the focus ring). The panel previews the
 * canvas at its true proportion, its share of the count, and the shared
 * coverage floor — the floor is a single brief setting, so every panel shows
 * the same `≥ N each`, never a per-ratio number.
 *
 * An excluded ratio is muted with its reason, not a bare disabled box: gating
 * blocks *entering* the state, so an excluded ratio the brief already selects
 * stays clickable — deselecting it is the way out.
 */
export function RatioPanel({
  ratio,
  selected,
  excluded,
  reason,
  allocation,
  count,
  floor,
  onToggle,
}: RatioPanelProps) {
  return (
    <AxisCard
      value={ratio.value}
      selected={selected}
      onToggle={onToggle}
      disabled={excluded && !selected}
      meta={`${ratio.width} × ${ratio.height}`}
    >
      <span className="flex flex-col items-center gap-1">
        <RatioFrame ratio={ratio.value} />
        <span
          className={cn("font-mono text-[11px]", excluded ? "text-text-muted" : "text-text-secondary")}
          aria-hidden="true"
        >
          {allocation} of {count}
        </span>
        <span className="font-mono text-[11px] text-text-muted" aria-hidden="true">
          {floor > 0 ? `≥ ${floor} each` : "no floor"}
        </span>
        {excluded && reason !== undefined ? (
          <span className="text-[11px] text-warning" aria-hidden="true">
            {reason}
          </span>
        ) : null}
      </span>
    </AxisCard>
  );
}
