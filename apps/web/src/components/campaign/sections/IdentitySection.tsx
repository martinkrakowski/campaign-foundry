"use client";

import { useId, useState, useRef, useEffect, type Dispatch } from "react";
import { Input, ChipGroup } from "@/components/ui";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import type { FieldErrors } from "@/components/campaign/validate";
import { keyForLabel } from "@/components/campaign/error-sections";
import { ErrorPill } from "@/components/ui/error-pill";
import { useSectionMode } from "@/components/campaign/SectionModeContext";
import { sectionOrder } from "./index";

import * as messages from "@/components/campaign/messages";

export const REGION_OPTIONS = ["GLOBAL", "EU", "DE", "UK", "US", "APAC"] as const;

export interface SectionProps {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  errors: FieldErrors;
}

export function SectionShell({
  id,
  title,
  children,
  errorCount,
  compact = false,
  onBlurCapture,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
  errorCount?: number;
  /** Sidebar placement: the bar's own heading scale, tighter rhythm. */
  compact?: boolean;
  /** Blur capture for field touch tracking (owned by L1.1). */
  onBlurCapture?: React.FocusEventHandler<HTMLElement>;
}) {
  const mode = useSectionMode();
  // D17: Derive numeral from id and mode — `sectionOrder` is the one ordered list of
  // sections (GB-D18), so the heading and the sidebar outline cannot disagree on it.
  const order = sectionOrder(mode);
  // `id` is a plain string on the props (SectionShell is used with ad-hoc ids too), so
  // widen the closed list for the lookup rather than narrowing the prop and rippling a
  // type change through every caller.
  const index = (order as readonly string[]).indexOf(id);
  const numeral = index >= 0 ? String(index + 1).padStart(2, "0") : "";
  // Strip leading "N · " from title (e.g., "1 · Identity" → "Identity")
  const strippedTitle = title.replace(/^\d+ · /, "");
  const displayTitle = numeral ? `${numeral} · ${strippedTitle}` : strippedTitle;

  // In the bar the surrounding Accordion is the heading, so render the body only —
  // two stacked titles would read as two sections.
  const instanceId = useId();
  const headingId = `${id}-heading-${instanceId}`;
  if (compact) {
    return (
      <section
        data-section={id}
        aria-label={displayTitle}
        className="space-y-3 scroll-mt-4"
        onBlurCapture={onBlurCapture}
      >
        {children}
      </section>
    );
  }
  return (
    <section
      id={id}
      data-section={id}
      aria-labelledby={headingId}
      className="space-y-4 scroll-mt-24"
      onBlurCapture={onBlurCapture}
    >
      <h2 id={headingId} className="flex items-center gap-2 text-lg font-semibold text-text-emphasis">
        {displayTitle}
        {errorCount ? <ErrorPill count={errorCount} /> : null}
      </h2>
      {children}
    </section>
  );
}

export function Field({
  label,
  error,
  hint,
  children,
  fieldKey,
  as = "label",
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
  fieldKey?: string;
  as?: "label" | "div";
}) {
  const derivedKey = fieldKey ?? keyForLabel(label);
  const Wrapper = as;
  return (
    <div data-field-key={derivedKey}>
      <Wrapper className="block">
        <span className="mb-1.5 block text-[11px] text-text-muted">{label}</span>
        {children}
      </Wrapper>
      {hint ? <span className="mt-1 block text-[11px] text-text-muted">{hint}</span> : null}
      {error ? <span className="mt-1 block text-[11px] text-error">{error}</span> : null}
    </div>
  );
}

export function IdentitySection({ state, dispatch, errors }: SectionProps) {
  const readOnly = state.source.kind === "file";
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const copyBriefId = async () => {
    if (!state.briefId || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(state.briefId);
      setCopied(true);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable — skip silently
    }
  };

  const campaignNameValue =
    state.source.kind === "file"
      ? state.briefId
      : state.campaignName || state.briefId;

  return (
    <SectionShell id="identity" title="1 · Identity" errorCount={countErrors(errors)}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field fieldKey="briefId" label={messages.campaignNameLabel} error={errors.briefId}>
          <Input
            aria-label={messages.campaignNameLabel}
            value={campaignNameValue}
            readOnly={readOnly}
            placeholder={messages.campaignNamePlaceholder}
            onChange={(e) => dispatch({ type: "patch", patch: { campaignName: e.target.value } })}
            invalid={Boolean(errors.briefId)}
          />
          <div className="mt-1 flex items-center justify-between font-mono text-[11px] text-text-muted">
            <span className="truncate max-w-[200px] sm:max-w-xs" title={state.briefId || undefined}>
              {state.briefId ? state.briefId : messages.briefIdReadout}
            </span>
            <button
              type="button"
              onClick={copyBriefId}
              disabled={!state.briefId}
              className="font-mono text-[10px] uppercase tracking-wider text-text-muted transition-colors hover:text-text-emphasis disabled:opacity-40"
              aria-label={messages.briefIdCopyAria}
            >
              {copied ? messages.briefIdCopied : messages.briefIdCopy}
            </button>
          </div>
        </Field>
        <Field fieldKey="targetRegion" label={messages.targetRegionLabel} error={errors.targetRegion} as="div">
          <ChipGroup
            label={messages.targetRegionLabel}
            otherInputLabel={messages.targetRegionOtherInputLabel}
            options={REGION_OPTIONS}
            value={state.targetRegion}
            onChange={(value) => dispatch({ type: "patch", patch: { targetRegion: value } })}
            allowOther
            otherLabel={messages.targetRegionOther}
            otherPlaceholder={messages.targetRegionOtherPlaceholder}
            invalid={Boolean(errors.targetRegion)}
          />
        </Field>
      </div>
      <Field fieldKey="targetAudience" label={messages.targetAudienceLabel} error={errors.targetAudience}>
        <Input
          aria-label={messages.targetAudienceLabel}
          value={state.targetAudience}
          placeholder={messages.targetAudiencePlaceholder}
          onChange={(e) => dispatch({ type: "patch", patch: { targetAudience: e.target.value } })}
          invalid={Boolean(errors.targetAudience)}
        />
      </Field>
    </SectionShell>
  );
}

export function countErrors(errors: FieldErrors): number {
  return Object.keys(errors).length;
}
