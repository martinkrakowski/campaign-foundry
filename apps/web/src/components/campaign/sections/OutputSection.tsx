"use client";

import { Button } from "@/components/ui";
import type { Dispatch } from "react";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import type { FieldErrors } from "@/components/campaign/validate";
import { SectionShell } from "./IdentitySection";
import { STATIC_PLATFORMS } from "@/components/campaign/editor-state";

export function OutputSection({ state, dispatch, errors }: { state: EditorState; dispatch: Dispatch<EditorAction>; errors: FieldErrors }) {
  return (
    <SectionShell id="output" title="5 · Output" errorCount={Object.keys(errors).filter((k) => k === "formats" || k === "platforms").length}>
      <div className="space-y-4">
        <div>
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-text-muted">Formats</h3>
          <div className="flex gap-2">
            {["static", "motion"].map((format) => {
              // Motion needs kinds and durations to be valid, and those controls arrive
              // in E2.3. Offering the toggle here would strand the draft in a state that
              // can never save. A brief that already declares motion still shows it.
              const deferred = format === "motion";
              return (
                <Button
                  key={format}
                  variant={state.formats.includes(format) ? "primary" : "secondary"}
                  size="sm"
                  disabled={deferred}
                  title={deferred ? "Motion output is configured in the variation policy section." : undefined}
                  onClick={() => dispatch({ type: "toggleFormat", value: format })}
                >
                  {format}
                </Button>
              );
            })}
          </div>
          {errors.formats ? <p className="mt-1 text-[11px] text-error">{errors.formats}</p> : null}
        </div>
        <div>
          <h3 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-text-muted">Platforms</h3>
          <div className="flex flex-wrap gap-2">
            {STATIC_PLATFORMS.map((platform) => (
              <Button
                key={platform}
                variant={state.platforms.includes(platform) ? "primary" : "secondary"}
                size="sm"
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
