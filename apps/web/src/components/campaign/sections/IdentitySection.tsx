"use client";

import { useId, type Dispatch } from "react";
import { Input } from "@/components/ui";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import type { FieldErrors } from "@/components/campaign/validate";

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
}: {
  id: string;
  title: string;
  children: React.ReactNode;
  errorCount?: number;
  /** Sidebar placement: the bar's own heading scale, tighter rhythm. */
  compact?: boolean;
}) {
  // In the bar the surrounding Accordion is the heading, so render the body only —
  // two stacked titles would read as two sections.
  const instanceId = useId();
  const headingId = `${id}-heading-${instanceId}`;
  if (compact) {
    return (
      <section data-section={id} aria-label={title} className="space-y-3 scroll-mt-4">
        {children}
      </section>
    );
  }
  return (
    <section id={id} data-section={id} aria-labelledby={headingId} className="space-y-4 scroll-mt-24">
      <h2 id={headingId} className="flex items-center gap-2 text-lg font-semibold text-white">
        {title}
        {errorCount ? (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-error px-1.5 text-[11px] font-bold text-white">
            {errorCount}
          </span>
        ) : null}
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
}: {
  label: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
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
