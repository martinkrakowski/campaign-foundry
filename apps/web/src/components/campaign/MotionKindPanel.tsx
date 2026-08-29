import type { ReactNode } from "react";
import { AxisCard, CreativeGlyph } from "@/components/ui";
import { MOTION_KINDS, type MotionKind } from "@campaignfoundry/CampaignOrchestration/motion-kinds";

export { MOTION_KINDS, type MotionKind };

/** Captions describing the visual transition performed by each motion kind (D9). */
export const MOTION_KIND_META: Record<MotionKind, string> = {
  "ken-burns-in": "slow zoom in",
  "ken-burns-out": "slow zoom out",
  "headline-rise": "text lifts and fades",
  "accent-wipe": "soft fade beneath band",
};

export interface MotionKindPanelProps {
  readonly kind: MotionKind;
  readonly selected: boolean;
  readonly onToggle: (kind: string) => void;
  readonly disabled?: boolean;
}

/**
 * Visual selection card for a motion style (D9 / U6).
 *
 * Hosts `CreativeGlyph motion={kind}` animating its specific transition,
 * with fallback cue glyphs for reduced-motion and disabled states.
 */
export function MotionKindPanel({
  kind,
  selected,
  onToggle,
  disabled = false,
}: MotionKindPanelProps): ReactNode {
  return (
    <AxisCard
      value={kind}
      selected={selected}
      onToggle={onToggle}
      disabled={disabled}
      meta={MOTION_KIND_META[kind]}
    >
      <CreativeGlyph motion={kind} />
    </AxisCard>
  );
}
