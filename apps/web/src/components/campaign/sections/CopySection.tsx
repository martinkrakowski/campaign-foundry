"use client";

import type { Dispatch } from "react";
import { useEffect } from "react";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/cn";
import * as messages from "@/components/campaign/messages";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import { MAX_HEADLINE_LENGTH, type FieldErrors } from "@/components/campaign/validate";
import { SectionShell, Field } from "./IdentitySection";
import { TimelineSection } from "@/components/campaign/TimelineSection";
import { getPool } from "@/lib/briefs-api";

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
  const { briefId, pool } = state;

  useEffect(() => {
    if (pool !== null || !briefId) return;
    let cancelled = false;
    const controller = new AbortController();
    getPool(briefId, controller.signal)
      .then((loaded) => {
        if (!cancelled && loaded) dispatch({ type: "loadPool", briefId, pool: loaded });
      })
      .catch(() => {
        // Benign fallback when network fails or 404
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [briefId, pool, dispatch]);

  const suggestions = (pool?.entries ?? [])
    .filter((entry) => entry.status === "approved")
    .slice(0, 4);

  return (
    <SectionShell
      id="copy"
      title="2 · Copy"
      errorCount={Object.keys(errors).filter((k) => k.startsWith("copy") || k === "campaignMessage" || k === "localizedMessage").length}
    >
      <Field fieldKey="campaignMessage" label={messages.headlineLabel} error={errors.campaignMessage}>
        <div className="space-y-3">
          {suggestions.length > 0 ? (
            <div className="space-y-1.5">
              <span className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
                {messages.headlineSuggestionsLabel}
              </span>
              <div className="flex flex-col gap-2">
                {suggestions.map((entry) => {
                  const isSelected = state.campaignMessage === entry.text;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      aria-label={entry.text}
                      aria-pressed={isSelected}
                      onClick={() => dispatch({ type: "patch", patch: { campaignMessage: entry.text } })}
                      className={cn(
                        "flex items-center gap-3 rounded-md border-[1.5px] px-3.5 py-2.5 text-left transition-all",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2",
                        "motion-safe:hover:-translate-y-px motion-safe:active:scale-[0.98]",
                        isSelected
                          ? "border-brand-primary bg-brand-primary/[0.08]"
                          : "border-border bg-surface-2 hover:border-border-hover hover:bg-surface-2/80",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "flex size-5 shrink-0 items-center justify-center transition-colors",
                          isSelected ? "text-brand-primary" : "text-text-muted",
                        )}
                      >
                        <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                          <path d="M8 1v3M8 12v3M1 8h3M12 8h3M3 3l2.5 2.5M10.5 10.5L13 13M3 13l2.5-2.5M10.5 5.5L13 3" strokeLinecap="round" />
                        </svg>
                      </span>
                      <span className={cn("min-w-0 flex-1 text-[13px] font-medium leading-tight", isSelected ? "text-text-emphasis" : "text-text-primary")}>
                        {entry.text}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-text-muted">
                        {messages.headlineCounter(entry.text.length, MAX_HEADLINE_LENGTH)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

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
            {messages.moreIdeas}
            <span className="sr-only">{messages.moreIdeasAria}</span>
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
