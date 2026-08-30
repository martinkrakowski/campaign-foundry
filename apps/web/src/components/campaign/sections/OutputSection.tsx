"use client";

import type { Dispatch } from "react";
import { FieldLine, PlatformCard, DurationStrip } from "@/components/ui";
import { MOTION_KINDS } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import { PLATFORM_PROFILES, isPlatformVisible } from "@campaignfoundry/Distribution/platform-profiles";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import { PLATFORM_ORDER } from "@/components/campaign/editor-state";
import type { FieldErrors } from "@/components/campaign/validate";
import { motionPackagedRatios } from "@/components/campaign/validate";
import { RATIO_OPTIONS } from "@/components/campaign/editor-state";
import { ratioDisplayName } from "@/components/campaign/display-names";
import * as messages from "@/components/campaign/messages";
import { SectionShell } from "./IdentitySection";
import { ProbeRow } from "../ProbeRow";
import { FormatPanel, formatGate } from "../FormatPanel";
import { MotionKindPanel } from "../MotionKindPanel";

export interface OutputSectionProps {
  readonly state: EditorState;
  readonly dispatch: Dispatch<EditorAction>;
  readonly errors: FieldErrors;
  readonly compact?: boolean;
}

/**
 * 05 Output section (D7–D10):
 * - ProbeRow showing host ffmpeg capability status.
 * - PlatformCard grid for "Where will the ads run?".
 * - Single amber exclusion line with inline [Add a photo platform] when motion excludes shapes.
 * - FormatPanel × 2 for Still images vs Video with per-card capability & mode gating.
 * - Nested Video section:
 *   - MotionKindPanel × 4 with animated CreativeGlyphs and reduced-motion fallback cues.
 *   - DurationStrip film strip on 0..30s grid with draggable slider beads and lanes slot.
 */
export function OutputSection({
  state,
  dispatch,
  errors,
  compact = false,
}: OutputSectionProps) {
  const motionRequested = state.formats.includes("motion");
  const motionOff = state.capabilities?.motion === false;

  // Platforms offered on this host that package at least one requested format.
  const capabilities = { motion: !motionOff };
  const offered = Object.values(PLATFORM_PROFILES).filter(
    (profile) =>
      isPlatformVisible(profile, capabilities) &&
      profile.formats.some((format) => state.formats.includes(format)),
  );
  const offeredIds = new Set(offered.map((profile) => profile.id));

  // A loaded brief may select platforms hidden on this host (D12: never strip data).
  // They stay visible and read-only.
  const hiddenSelected = state.platforms.filter((id) => !offeredIds.has(id));

  const allVisiblePlatforms = Array.from(
    new Set([...PLATFORM_ORDER.filter((id) => offeredIds.has(id)), ...hiddenSelected]),
  );

  const platformDisabled = (id: string): boolean => {
    const profile = PLATFORM_PROFILES[id];
    return profile !== undefined && !isPlatformVisible(profile, capabilities);
  };

  // Motion narrowing / exclusion calculation (D7 / L4.7)
  const motionOnly = state.formats.includes("motion") && !state.formats.includes("static");
  const packaged = motionPackagedRatios(state);
  const motionRatios = RATIO_OPTIONS.filter((ratio) => packaged.has(ratio));
  const hasExcludedRatio = motionOnly && packaged.size < RATIO_OPTIONS.length;

  const outputErrorCount = Object.keys(errors).filter((k) =>
    ["formats", "platforms", "motion", "duration"].includes(k),
  ).length;

  const staticGate = formatGate("static", state, state.capabilities);
  const motionGate = formatGate("motion", state, state.capabilities);

  return (
    <SectionShell id="output" title="5 · Output" errorCount={outputErrorCount} compact={compact}>
      <div className="space-y-6">
        <ProbeRow capabilities={state.capabilities} />

        {/* Where will the ads run? */}
        <fieldset className="space-y-2">
          <legend className="text-[11px] text-text-muted">{messages.outputPlatformsLegend}</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {allVisiblePlatforms.map((id) => {
              const profile = PLATFORM_PROFILES[id];
              if (!profile) return null;
              return (
                <PlatformCard
                  key={id}
                  profile={profile}
                  selected={state.platforms.includes(id)}
                  disabled={platformDisabled(id)}
                  onToggle={(platformId) => dispatch({ type: "togglePlatform", value: platformId })}
                />
              );
            })}
          </div>

          {/* Single amber exclusion line with inline [Add a photo platform] (D7 / L4.7) */}
          {hasExcludedRatio ? (
            <div className="flex flex-wrap items-center gap-2 pt-1 text-[11px] text-warning">
              <span>
                {motionRatios.length > 0
                  ? messages.ratioExcludedPackaged(motionRatios.map(ratioDisplayName))
                  : messages.ratioExcludedNone()}
              </span>
              <button
                type="button"
                onClick={() => dispatch({ type: "addPhotoOutput" })}
                className="underline hover:text-text-primary"
              >
                {messages.addPhotoPlatform}
              </button>
            </div>
          ) : null}

          {errors.platforms ? <FieldLine tone="error">{errors.platforms}</FieldLine> : null}
        </fieldset>

        {/* Formats */}
        <fieldset className="space-y-2">
          <legend className="text-[11px] text-text-muted">{messages.outputFormatsLegend}</legend>
          <div className="grid grid-cols-2 gap-2">
            <FormatPanel
              format="static"
              selected={state.formats.includes("static")}
              onToggle={(value) => dispatch({ type: "toggleFormat", value })}
              gate={staticGate}
            />
            <FormatPanel
              format="motion"
              selected={state.formats.includes("motion")}
              onToggle={(value) => dispatch({ type: "toggleFormat", value })}
              gate={motionGate}
            />
          </div>
          {errors.formats ? <FieldLine tone="error">{errors.formats}</FieldLine> : null}
        </fieldset>

        {/* Video options (Motion kinds & Duration) */}
        {motionRequested ? (
          <div id="motion" className="space-y-6 rounded-md border-l-2 border-brand-primary/40 pl-4 scroll-mt-24">
            <fieldset className="space-y-2">
              <legend className="text-[11px] text-text-muted">{messages.outputMotionLegend}</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {MOTION_KINDS.map((kind) => (
                  <MotionKindPanel
                    key={kind}
                    kind={kind}
                    selected={state.motion.includes(kind)}
                    onToggle={(value) => dispatch({ type: "toggleMotion", value })}
                  />
                ))}
              </div>
              {errors.motion ? <FieldLine tone="error">{errors.motion}</FieldLine> : null}
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-[11px] text-text-muted">{messages.outputDurationLegend}</legend>
              <DurationStrip
                values={state.duration}
                onChange={(index, value) => dispatch({ type: "setDuration", index, value })}
                onAdd={(value) => dispatch({ type: "addDuration", value })}
                onRemove={(index) => dispatch({ type: "removeDuration", index })}
                error={errors.duration}
              />
            </fieldset>
          </div>
        ) : null}
      </div>
    </SectionShell>
  );
}
