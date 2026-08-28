"use client";

import { useId, type Dispatch } from "react";
import { Input } from "@/components/ui";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import type { FieldErrors } from "@/components/campaign/validate";
import { keyForLabel } from "@/components/campaign/error-sections";
import { ErrorPill } from "@/components/ui/error-pill";
import { useSectionMode } from "@/components/campaign/SectionModeContext";

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
  // D17: Derive numeral from id and mode
  const order = mode === "variation"
    ? ["identity", "copy", "products", "output", "policy"]
    : ["identity", "copy", "products", "treatments", "output"];
  const index = order.indexOf(id);
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
      <h2 id={headingId} className="flex items-center gap-2 text-lg font-semibold text-white">
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
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
  fieldKey?: string;
}) {
  const derivedKey = fieldKey ?? keyForLabel(label);
  return (
    <div data-field-key={derivedKey}>
      <label className="block">
        <span className="mb-1.5 block text-[11px] text-text-muted">{label}</span>
        {children}
      </label>
      {hint ? <span className="mt-1 block text-[11px] text-text-muted">{hint}</span> : null}
      {error ? <span className="mt-1 block text-[11px] text-error">{error}</span> : null}
    </div>
  );
}

export function IdentitySection({ state, dispatch, errors }: SectionProps) {
  const readOnly = state.source.kind === "file";
  return (
    <SectionShell id="identity" title="1 · Identity" errorCount={countErrors(errors)}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Brief ID" error={errors.briefId}>
          <Input
            value={state.briefId}
            readOnly={readOnly}
            onChange={(e) => dispatch({ type: "patch", patch: { briefId: e.target.value } })}
            invalid={Boolean(errors.briefId)}
          />
        </Field>
        <Field label="Target Region" error={errors.targetRegion}>
          <Input
            value={state.targetRegion}
            onChange={(e) => dispatch({ type: "patch", patch: { targetRegion: e.target.value } })}
            invalid={Boolean(errors.targetRegion)}
          />
        </Field>
      </div>
      <Field label="Target Audience" error={errors.targetAudience}>
        <Input
          value={state.targetAudience}
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
