"use client";

import type { Dispatch } from "react";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/cn";
import * as messages from "@/components/campaign/messages";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import { MAX_HEADLINE_LENGTH, type FieldErrors } from "@/components/campaign/validate";
import { SectionShell, Field } from "./IdentitySection";
import { TimelineSection } from "@/components/campaign/TimelineSection";

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
      <Field fieldKey="campaignMessage" label={messages.headlineLabel} error={errors.campaignMessage}>
        <div className="space-y-1">
          <Input
            aria-label={messages.headlineLabel}
            value={state.campaignMessage}
            placeholder={messages.headlinePlaceholder}
            onChange={(e) => dispatch({ type: "patch", patch: { campaignMessage: e.target.value } })}
            invalid={Boolean(errors.campaignMessage)}
          />
          <div className="flex justify-end text-[11px]">
            <span
              className={cn(
                state.campaignMessage.length > MAX_HEADLINE_LENGTH ? "text-error font-medium" : "text-text-muted",
              )}
            >
              {messages.headlineCounter(state.campaignMessage.length, MAX_HEADLINE_LENGTH)}
            </span>
          </div>
        </div>
      </Field>

      <Field fieldKey="localizedMessage" label={messages.localizedHeadlineLabel} error={errors.localizedMessage}>
        <Input
          aria-label={messages.localizedHeadlineLabel}
          value={state.localizedMessage}
          placeholder={messages.localizedHeadlinePlaceholder}
          onChange={(e) => dispatch({ type: "patch", patch: { localizedMessage: e.target.value } })}
          invalid={Boolean(errors.localizedMessage)}
        />
      </Field>

      {state.mode === "variation" ? (
        <div className="mt-2">
          <Button variant="ghost" size="sm" type="button" onClick={onOpenPool}>
            {messages.extraHeadlines}
            <span className="sr-only">{messages.extraHeadlinesAria}</span>
          </Button>
        </div>
      ) : null}

      {/* L6 copy timeline sub-panel (2026-08-27_motion-copy-timeline.md E5.2 / D11). Only a
          Randomized brief can render motion, so a classic draft never offers a sequence. */}
      {state.mode === "variation" ? (
        <div data-slot="copy-timeline">
          <TimelineSection state={state} dispatch={dispatch} />
        </div>
      ) : null}
    </SectionShell>
  );
}
