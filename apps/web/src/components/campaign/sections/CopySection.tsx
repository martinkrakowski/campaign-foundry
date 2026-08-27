"use client";

import { Button, Input } from "@/components/ui";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import type { FieldErrors } from "@/components/campaign/validate";
import { SectionShell, Field } from "./IdentitySection";

export function CopySection({ state, dispatch, errors, onOpenPool }: { state: EditorState; dispatch: React.Dispatch<EditorAction>; errors: FieldErrors; onOpenPool?: () => void }) {
  return (
    <SectionShell id="copy" title="2 · Copy" errorCount={Object.keys(errors).filter((k) => k.startsWith("copy")).length}>
      <Field label="Campaign Message" error={errors.campaignMessage}>
        <Input
          value={state.campaignMessage}
          onChange={(e) => dispatch({ type: "patch", patch: { campaignMessage: e.target.value } })}
          invalid={Boolean(errors.campaignMessage)}
        />
      </Field>
      <Field label="Localized Message (optional)" error={errors.localizedMessage}>
        <Input
          value={state.localizedMessage}
          onChange={(e) => dispatch({ type: "patch", patch: { localizedMessage: e.target.value } })}
          invalid={Boolean(errors.localizedMessage)}
        />
      </Field>
      {state.mode === "variation" ? (
        <div className="mt-4">
          <Button variant="secondary" size="sm" onClick={onOpenPool}>
            Manage Headline Pool
          </Button>
        </div>
      ) : null}
    </SectionShell>
  );
}
