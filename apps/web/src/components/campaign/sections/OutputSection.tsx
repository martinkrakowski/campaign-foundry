"use client";

import type { Dispatch } from "react";
import { Button, Input } from "@/components/ui";
import { MOTION_KINDS } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import { PLATFORM_PROFILES, isPlatformVisible } from "@campaignfoundry/Distribution/platform-profiles";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import { MIN_DURATION_SEC, MAX_DURATION_SEC, type FieldErrors } from "@/components/campaign/validate";
import { SectionShell } from "./IdentitySection";

export function OutputSection({ state, dispatch, errors }: { state: EditorState; dispatch: Dispatch<EditorAction>; errors: FieldErrors }) {
  const motionRequested = state.formats.includes("motion");
  // Unknown capabilities (probe unreachable) must not read as "no motion" — only a
  // definite false from the probe gates anything.
  const motionOff = state.capabilities?.motion === false;
  const motionReason = motionOff ? (state.capabilities?.reason ?? "capability off") : undefined;

  // Platforms this host can produce that package at least one requested format.
  const capabilities = { motion: !motionOff };
  const offered = Object.values(PLATFORM_PROFILES).filter(
    (profile) => isPlatformVisible(profile, capabilities) && profile.formats.some((format) => state.formats.includes(format)),
  );
  const offeredIds = new Set(offered.map((profile) => profile.id));
  // A loaded brief may select platforms the current filters hide (D12: a host with no
  // motion must not strip the motion platforms the file already declares). They stay
  // visible; capability-hidden ones are read-only, format-mismatched ones can still be
  // deselected so a compatibility error always has a way out.
  const hiddenSelected = state.platforms.filter((id) => !offeredIds.has(id));
  // Only a capability-hidden platform is locked: the file declared it and this host
  // cannot produce it, so it stays read-only (D12 — gating never strips data). A
  // format-mismatched selection stays deselectable so a compatibility error always
  // has a way out.
  const platformDisabled = (id: string): boolean => {
    const profile = PLATFORM_PROFILES[id];
    return profile !== undefined && !isPlatformVisible(profile, capabilities);
  };

  return (
    <SectionShell id="output" title="5 · Output" errorCount={Object.keys(errors).filter((k) => k === "formats" || k === "platforms").length}>
      <div className="space-y-4">
        <div>
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-text-muted">Formats</h3>
          <div className="flex gap-2">
            {["static", "motion"].map((format) => {
              const gated = format === "motion" && motionOff;
              return (
                <Button
                  key={format}
                  variant={state.formats.includes(format) ? "primary" : "secondary"}
                  size="sm"
                  disabled={gated}
                  title={gated ? `Motion is not available on this host: ${motionReason}` : undefined}
                  onClick={() => dispatch({ type: "toggleFormat", value: format })}
                >
                  {format}
                </Button>
              );
            })}
          </div>
          {motionOff ? (
            <p className="mt-1 text-[11px] text-text-muted">
              Motion is not available on this host: {motionReason}.
            </p>
          ) : null}
          {errors.formats ? <p className="mt-1 text-[11px] text-error">{errors.formats}</p> : null}
        </div>
        {motionRequested ? (
          <div id="motion" className="space-y-4 scroll-mt-24">
            <div>
              <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-text-muted">Motion kinds</h3>
              <div className="flex flex-wrap gap-2">
                {MOTION_KINDS.map((kind) => (
                  <Button
                    key={kind}
                    variant={state.motion.includes(kind) ? "primary" : "secondary"}
                    size="sm"
                    disabled={motionOff}
                    onClick={() => dispatch({ type: "toggleMotion", value: kind })}
                  >
                    {kind}
                  </Button>
                ))}
              </div>
              {errors.motion ? <p className="mt-1 text-[11px] text-error">{errors.motion}</p> : null}
            </div>
            <div>
              <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-text-muted">Durations (seconds)</h3>
              <div className="space-y-2">
                {state.duration.map((seconds, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={MIN_DURATION_SEC}
                      max={MAX_DURATION_SEC}
                      step={1}
                      value={seconds}
                      aria-label={`Duration ${index + 1} (seconds)`}
                      disabled={motionOff}
                      invalid={Boolean(errors.duration)}
                      onChange={(e) =>
                        dispatch({ type: "setDuration", index, value: Number(e.target.value) })
                      }
                      className="w-28"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={motionOff}
                      onClick={() => dispatch({ type: "removeDuration", index })}
                    >
                      Remove
                    </Button>
                  </div>
                ))}
                <Button variant="secondary" size="sm" disabled={motionOff} onClick={() => dispatch({ type: "addDuration" })}>
                  Add duration
                </Button>
              </div>
              {errors.duration ? <p className="mt-1 text-[11px] text-error">{errors.duration}</p> : null}
            </div>
          </div>
        ) : null}
        <div>
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-text-muted">Platforms</h3>
          <div className="flex flex-wrap gap-2">
            {[...offered.map((profile) => profile.id), ...hiddenSelected].map((platform) => (
              <Button
                key={platform}
                variant={state.platforms.includes(platform) ? "primary" : "secondary"}
                size="sm"
                disabled={platformDisabled(platform)}
                onClick={() => dispatch({ type: "togglePlatform", value: platform })}
              >
                {platform}
              </Button>
            ))}
          </div>
          {errors.platforms ? <p className="mt-1 text-[11px] text-error">{errors.platforms}</p> : null}
        </div>
      </div>
    </SectionShell>
  );
}
