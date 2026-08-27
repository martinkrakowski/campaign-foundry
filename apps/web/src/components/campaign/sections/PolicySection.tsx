"use client";

import type { Dispatch } from "react";
import { Input } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import type { FieldErrors } from "@/components/campaign/validate";
import { maxMinDistance } from "@/components/campaign/validate";
import { SectionShell, Field } from "./IdentitySection";
import {
  LAYOUT_OPTIONS,
  TONE_OPTIONS,
  BACKGROUND_OPTIONS,
  PALETTE_SHIFT_OPTIONS,
  HEADLINE_POOL_REF,
  approvedHeadlines,
} from "@/components/campaign/editor-state";
import { EstimatePanel } from "@/components/campaign/EstimatePanel";

function AxisToggles({
  legend,
  options,
  selected,
  onToggle,
  error,
}: {
  legend: string;
  options: readonly string[];
  selected: readonly string[];
  onToggle: (value: string) => void;
  error?: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-[11px] text-text-muted">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const on = selected.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(option)}
              className={cn(
                "rounded-md border px-3 py-1.5 font-mono text-[12px] transition-colors",
                on ? "border-brand-primary bg-surface-2 text-white" : "border-border text-text-muted",
              )}
            >
              {option}
            </button>
          );
        })}
      </div>
      {error ? <span className="block text-[11px] text-error">{error}</span> : null}
    </fieldset>
  );
}

const HEADLINE_POOL_EMPTY =
  "The headline pool has no approved entries — approve at least one in the Copy step.";

function HeadlineAxisToggle({ state, dispatch }: { state: EditorState; dispatch: Dispatch<EditorAction> }) {
  const poolLoaded = state.pool !== null;
  const approvedCount = approvedHeadlines(state.pool);
  const hasApproved = approvedCount > 0;
  // Blocked means "cannot be switched on". Turning it *off* must always be possible:
  // loadPool deliberately no longer clears the axis for the user, so the toggle is the
  // only way out of an axis enabled against a pool with nothing approved.
  const on = state.variation.headline;
  const blocked = poolLoaded && !hasApproved;
  const disabled = blocked && !on;
  return (
    <fieldset className="space-y-2">
      <legend className="text-[11px] text-text-muted">Headline</legend>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={on}
          disabled={disabled}
          onClick={() => dispatch({ type: "toggleHeadline" })}
          className={cn(
            "rounded-md border px-3 py-1.5 font-mono text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            on ? "border-brand-primary bg-surface-2 text-white" : "border-border text-text-muted",
          )}
        >
          {HEADLINE_POOL_REF}
        </button>
        <span className="text-[11px] text-text-muted">
          {!poolLoaded
            ? "Headline pool not loaded. Open the headline drawer to view available headlines."
            : !hasApproved
              ? HEADLINE_POOL_EMPTY
              : `${approvedCount} approved headline${approvedCount === 1 ? "" : "s"}`}
        </span>
      </div>
    </fieldset>
  );
}

export function PolicySection({ state, dispatch, errors }: { state: EditorState; dispatch: Dispatch<EditorAction>; errors: FieldErrors }) {
  if (state.mode !== "variation") return null;

  return (
    <SectionShell id="policy" title="4 · Variation Policy" errorCount={Object.keys(errors).length}>
      <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Count" error={errors.count}>
            <Input
              type="number"
              value={state.variation.count}
              onChange={(e) => dispatch({ type: "setVariation", field: "count", value: e.target.value })}
              invalid={Boolean(errors.count)}
            />
          </Field>
          <Field label="Seed (optional)" error={errors.seed}>
            <Input
              type="number"
              value={state.variation.seed}
              onChange={(e) => dispatch({ type: "setVariation", field: "seed", value: e.target.value })}
              invalid={Boolean(errors.seed)}
            />
          </Field>
          <Field
            label="Min Distance"
            error={errors.minDistance}
            hint={`Whole seconds, 0–${maxMinDistance(state)} — the number of active axes`}
          >
            <Input
              type="number"
              value={state.variation.minDistance}
              onChange={(e) => dispatch({ type: "setVariation", field: "minDistance", value: e.target.value })}
              invalid={Boolean(errors.minDistance)}
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Coverage per Product" error={errors.perProduct}>
            <Input
              type="number"
              value={state.variation.perProduct}
              onChange={(e) => dispatch({ type: "setVariation", field: "perProduct", value: e.target.value })}
              invalid={Boolean(errors.perProduct)}
            />
          </Field>
          <Field label="Coverage per Ratio" error={errors.perRatio}>
            <Input
              type="number"
              value={state.variation.perRatio}
              onChange={(e) => dispatch({ type: "setVariation", field: "perRatio", value: e.target.value })}
              invalid={Boolean(errors.perRatio)}
            />
          </Field>
        </div>
        <AxisToggles
          legend="Layout"
          options={LAYOUT_OPTIONS}
          selected={state.variation.layout}
          onToggle={(value) => dispatch({ type: "toggleLayout", value })}
          error={errors.layout}
        />
        <AxisToggles
          legend="Tone"
          options={TONE_OPTIONS}
          selected={state.variation.tone}
          onToggle={(value) => dispatch({ type: "toggleTone", value })}
          error={errors.tone}
        />
        <AxisToggles
          legend="Background Source"
          options={BACKGROUND_OPTIONS}
          selected={state.variation.background}
          onToggle={(value) => dispatch({ type: "toggleBackground", value })}
          error={errors.background}
        />
        <fieldset className="space-y-2">
          <legend className="text-[11px] text-text-muted">Palette Shift</legend>
          <div className="flex flex-wrap gap-2">
            {PALETTE_SHIFT_OPTIONS.map((option) => {
              const on = state.variation.paletteShift.includes(option);
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={on}
                  onClick={() => dispatch({ type: "togglePalette", value: option })}
                  className={cn(
                    "rounded-md border px-3 py-1.5 font-mono text-[12px] transition-colors",
                    on ? "border-brand-primary bg-surface-2 text-white" : "border-border text-text-muted",
                  )}
                >
                  {option}
                </button>
              );
            })}
          </div>
          {errors.paletteShift ? (
            <span className="block text-[11px] text-error">{errors.paletteShift}</span>
          ) : null}
        </fieldset>
        <HeadlineAxisToggle state={state} dispatch={dispatch} />
        <EstimatePanel state={state} />
      </div>
    </SectionShell>
  );
}
