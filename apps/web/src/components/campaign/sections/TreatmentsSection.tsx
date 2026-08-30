"use client";

import { Button, Input } from "@/components/ui";
import type { Dispatch } from "react";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import type { FieldErrors } from "@/components/campaign/validate";
import { SectionShell, Field } from "./IdentitySection";
import { LAYOUT_OPTIONS, TONE_OPTIONS } from "@/components/campaign/editor-state";

export function TreatmentsSection({ state, dispatch, errors }: { state: EditorState; dispatch: Dispatch<EditorAction>; errors: FieldErrors }) {
  if (state.mode !== "brief") return null;

  return (
    <SectionShell id="treatments" title="4 · Treatments" errorCount={Object.keys(errors).filter((k) => k.startsWith("treatment")).length}>
      {errors.treatments ? <p className="text-[13px] text-error">{errors.treatments}</p> : null}
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
          Treatments ({state.treatments.length})
        </h3>
        <Button variant="secondary" size="sm" onClick={() => dispatch({ type: "addTreatment" })}>
          Add treatment
        </Button>
      </div>
      {state.treatments.map((treatment, index) => (
        <div key={index} className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="ID" error={errors[`treatment-${index}-id`]}>
              <Input
                value={treatment.id}
                onChange={(e) =>
                  dispatch({ type: "setTreatment", index, patch: { id: e.target.value } })
                }
                invalid={Boolean(errors[`treatment-${index}-id`])}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field fieldKey={`treatment-${index}-layout`} label="Layout" error={errors[`treatment-${index}-layout`]}>
              <select
                value={treatment.layout}
                onChange={(e) =>
                  dispatch({ type: "setTreatment", index, patch: { layout: e.target.value } })
                }
                className="rounded border border-border bg-surface px-3 py-2 text-sm text-text-emphasis"
              >
                {LAYOUT_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </Field>
            <Field fieldKey={`treatment-${index}-tone`} label="Tone" error={errors[`treatment-${index}-tone`]}>
              <select
                value={treatment.tone}
                onChange={(e) =>
                  dispatch({ type: "setTreatment", index, patch: { tone: e.target.value } })
                }
                className="rounded border border-border bg-surface px-3 py-2 text-sm text-text-emphasis"
              >
                {TONE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </Field>
          </div>
          <Button variant="ghost" size="sm" onClick={() => dispatch({ type: "removeTreatment", index })}>
            Remove
          </Button>
        </div>
      ))}
      {state.treatments.length === 0 ? (
        <p className="text-[13px] text-text-muted">No treatments. The default treatment will be used.</p>
      ) : null}
    </SectionShell>
  );
}
