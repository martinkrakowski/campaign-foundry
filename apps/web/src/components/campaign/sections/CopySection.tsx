"use client";

import type { Dispatch } from "react";
import { Button, Input } from "@/components/ui";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import type { FieldErrors } from "@/components/campaign/validate";
import { SectionShell, Field } from "./IdentitySection";

export function CopySection({
  state,
  dispatch,
  errors,
  onOpenPool,
}: {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  errors: FieldErrors;
  onOpenPool?: () => void;
}) {
  return (
    <SectionShell
      id="copy"
      title="2 · Copy"
      errorCount={Object.keys(errors).filter((k) => k.startsWith("copy") || k === "campaignMessage" || k === "localizedMessage").length}
    >
      <Field fieldKey="campaignMessage" label="Headline" error={errors.campaignMessage}>
        <div className="space-y-1">
          <Input
            aria-label="Campaign Message"
            value={state.campaignMessage}
            placeholder="e.g. Stay wild. Stay hydrated."
            onChange={(e) => dispatch({ type: "patch", patch: { campaignMessage: e.target.value } })}
            invalid={Boolean(errors.campaignMessage)}
          />
          <div className="flex justify-end text-[11px] text-text-muted">
            <span>{state.campaignMessage.length} / 60</span>
          </div>
        </div>
      </Field>

      <Field fieldKey="localizedMessage" label="Localized headline (optional)" error={errors.localizedMessage}>
        <Input
          aria-label="Localized Message (optional)"
          value={state.localizedMessage}
          placeholder="e.g. Bleib wild. Bleib hydriert."
          onChange={(e) => dispatch({ type: "patch", patch: { localizedMessage: e.target.value } })}
          invalid={Boolean(errors.localizedMessage)}
        />
      </Field>

      {state.mode === "variation" ? (
        <div className="mt-2">
          <Button variant="ghost" size="sm" type="button" onClick={onOpenPool}>
            Extra headlines…
            <span className="sr-only">Manage Headline Pool</span>
          </Button>
        </div>
      ) : null}

      {/* Slot for L6 copy timeline sub-panel (2026-08-27_motion-copy-timeline.md E5.2 / D11) */}
      <div data-slot="copy-timeline" />
    </SectionShell>
  );
}
