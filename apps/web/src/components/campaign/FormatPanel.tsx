import type { ReactNode } from "react";
import { AxisCard, CreativeGlyph } from "@/components/ui";
import { MOTION_FPS } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import { MIN_DURATION_SEC, MAX_DURATION_SEC } from "@campaignfoundry/CampaignOrchestration/variation-defaults";
import * as messages from "@/components/campaign/messages";

export interface FormatGateResult {
  readonly gated: boolean;
  readonly disabled: boolean;
  readonly description?: string;
}

/**
 * Determines whether a format is available or gated (D8 / L4.4).
 *
 * Gating prevents *selecting* motion on a host without ffmpeg or in Classic mode,
 * but NEVER prevents deselecting it (leaving an invalid/unsupported state must always be possible).
 */
export function formatGate(
  format: string,
  state: { mode: string; formats: readonly string[] },
  capabilities: { motion: boolean; reason?: string } | null,
): FormatGateResult {
  const selected = state.formats.includes(format);
  if (format === "motion") {
    if (capabilities?.motion === false) {
      return {
        gated: true,
        disabled: !selected,
        description: messages.formatsMotionUnavailable,
      };
    }
    if (state.mode === "brief") {
      return {
        gated: true,
        disabled: !selected,
        description: messages.formatsMotionNeedsRandomized,
      };
    }
  }
  return {
    gated: false,
    disabled: false,
  };
}

export interface FormatPanelProps {
  readonly format: "static" | "motion";
  readonly selected: boolean;
  readonly onToggle: (format: string) => void;
  readonly gate?: FormatGateResult;
}

/**
 * Selectable card for Still images vs Video formats (D8 / U5).
 *
 * - Still: shows `CreativeGlyph` at rest with caption "still · one frame".
 * - Video: shows `CreativeGlyph` looping a slow ken-burns-in with caption "clip · 30 fps · 2–30 s".
 */
export function FormatPanel({
  format,
  selected,
  onToggle,
  gate,
}: FormatPanelProps): ReactNode {
  const isMotion = format === "motion";
  const meta = isMotion
    ? `clip · ${MOTION_FPS} fps · ${MIN_DURATION_SEC}–${MAX_DURATION_SEC} s`
    : "still · one frame";

  return (
    <AxisCard
      value={format}
      selected={selected}
      onToggle={onToggle}
      disabled={gate?.disabled ?? false}
      meta={meta}
      {...(gate?.description ? { description: gate.description } : {})}
    >
      <CreativeGlyph motion={isMotion ? "ken-burns-in" : undefined} />
    </AxisCard>
  );
}
