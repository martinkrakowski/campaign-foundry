"use client";

import type { Dispatch, ReactNode } from "react";
import { RATIO_DIMENSIONS, RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { AxisCard, Button, CreativeGlyph, Input, Slider, Stepper } from "@/components/ui";
import { cn } from "@/lib/cn";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import { RATIO_OPTIONS } from "@/components/campaign/editor-state";
import { RatioPanel } from "@/components/campaign/RatioPanel";
import {
  axisProductSize,
  drawableRatios,
  maxMinDistance,
  motionPackagedRatios,
  ratioAllocation,
  type FieldErrors,
} from "@/components/campaign/validate";
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

/**
 * The card variant of an axis: each option previews what the compositor will
 * draw for it (via `render`) instead of naming it alone. Used where the choice
 * is visual — layout and tone. In the 320px sidebar the grid must hold two
 * cards per row; wider containers let cards auto-fill.
 */
function AxisCards<T extends string>({
  legend,
  options,
  selected,
  onToggle,
  error,
  compact,
  render,
}: {
  legend: string;
  options: readonly T[];
  selected: readonly string[];
  onToggle: (value: string) => void;
  error?: string;
  compact: boolean;
  render: (option: T) => ReactNode;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-[11px] text-text-muted">{legend}</legend>
      <div
        className={cn(
          "grid gap-2",
          compact ? "grid-cols-2" : "grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]",
        )}
      >
        {options.map((option) => (
          <AxisCard key={option} value={option} selected={selected.includes(option)} onToggle={onToggle}>
            {render(option)}
          </AxisCard>
        ))}
      </div>
      {error ? <span className="block text-[11px] text-error">{error}</span> : null}
    </fieldset>
  );
}

const HEADLINE_POOL_EMPTY =
  "The headline pool has no approved entries — approve at least one in the Copy step.";

/**
 * The ratio axis: the three canvas panels, the coverage-per-ratio Stepper that
 * sets their shared floor, and the constraint readout that binds the two — the
 * Stepper sits beside the panels so the cause (the floor) and its effect (each
 * panel's share of the count) stay in one place.
 */
function RatioAxis({
  state,
  dispatch,
  errors,
  compact,
}: {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  errors: FieldErrors;
  compact: boolean;
}) {
  const count = Math.max(0, Number.parseInt(state.variation.count, 10) || 0);
  const floor = Math.max(0, Number.parseInt(state.variation.perRatio, 10) || 0);
  const drawable = drawableRatios(state);
  const allocations = ratioAllocation(state);
  // The same motion narrowing the policy applies: a motion-only plan draws only
  // the ratios its requested platforms package.
  const motionOnly = state.formats.includes("motion") && !state.formats.includes("static");
  const packaged = motionPackagedRatios(state);
  const motionRatios = RATIO_OPTIONS.filter((ratio) => packaged.has(ratio));
  const ratioFloorTotal = floor * drawable.length;
  // Mirrors the planner's refusal (perRatio × ratios it will draw > count), so
  // the coupling surfaces before the run instead of as a shortfall error after.
  const over = floor > 0 && ratioFloorTotal > count;
  const reason =
    motionRatios.length > 0
      ? `Excluded — motion-only output draws [${motionRatios.join(", ")}] only; add the static format to draw this ratio.`
      : "Excluded — no selected platform packages motion at any ratio; add the static format to draw this ratio.";

  return (
    <fieldset className="space-y-2">
      <legend className="text-[11px] text-text-muted">Aspect ratios</legend>
      <Field label="Coverage per ratio" error={errors.perRatio} hint="Fewest creatives each aspect ratio must get">
        <Stepper
          aria-label="Coverage per ratio"
          min={0}
          max={Math.max(1, Number.parseInt(state.variation.count, 10) || 1)}
          value={state.variation.perRatio}
          invalid={Boolean(errors.perRatio)}
          allowUnset
          unsetLabel="No floor"
          onChange={(value) => dispatch({ type: "setVariation", field: "perRatio", value })}
        />
      </Field>
      <p className={cn("text-[11px]", over ? "text-error" : "text-text-muted")}>
        floor {floor} × {drawable.length} selected = {ratioFloorTotal} of count {count}
        {over ? " — lower the floor, raise the count, or select fewer ratios" : ""}
      </p>
      <div
        className={cn(
          "grid gap-2",
          compact ? "grid-cols-2" : "grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]",
        )}
      >
        {RATIO_VALUES.map((value) => (
          <RatioPanel
            key={value}
            ratio={{ value, ...RATIO_DIMENSIONS[value] }}
            selected={state.variation.ratio.includes(value)}
            excluded={motionOnly && !packaged.has(value)}
            reason={motionOnly ? reason : undefined}
            allocation={allocations[value]}
            count={count}
            floor={floor}
            onToggle={(value) => dispatch({ type: "toggleRatio", value })}
          />
        ))}
      </div>
      {errors.ratio ? <span className="block text-[11px] text-error">{errors.ratio}</span> : null}
    </fieldset>
  );
}

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

export function PolicySection({ state, dispatch, errors, compact = false }: { state: EditorState; dispatch: Dispatch<EditorAction>; errors: FieldErrors; compact?: boolean }) {
  if (state.mode !== "variation") return null;
  const axisMax = axisProductSize(state);

  return (
    <SectionShell id="policy" title="4 · Variation Policy" errorCount={Object.keys(errors).length} compact={compact}>
      <div className="space-y-6">
        <div className={compact ? "space-y-4" : "grid grid-cols-1 gap-4 sm:grid-cols-3"}>
          <Field
            label="Count"
            error={errors.count}
            hint={`How many creatives to draw — at most ${axisMax} from these axes`}
          >
            <Slider
              aria-label="Count"
              min={1}
              max={axisMax}
              value={Number.parseInt(state.variation.count, 10) || 1}
              invalid={Boolean(errors.count)}
              onChange={(value) => dispatch({ type: "setVariation", field: "count", value: String(value) })}
            />
          </Field>
          <Field
            label="Min distance"
            error={errors.minDistance}
            hint={`How many axes any two creatives must differ in — up to ${maxMinDistance(state)}, the active axes`}
          >
            <Stepper
              aria-label="Min distance"
              min={0}
              max={maxMinDistance(state)}
              value={state.variation.minDistance}
              invalid={Boolean(errors.minDistance)}
              allowUnset
              unsetLabel="Auto (1)"
              onChange={(value) => dispatch({ type: "setVariation", field: "minDistance", value })}
            />
          </Field>
          <Field label="Seed" error={errors.seed} hint="Fixes the draw, so the same brief plans the same creatives">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                placeholder="Auto"
                value={state.variation.seed}
                invalid={Boolean(errors.seed)}
                onChange={(e) => dispatch({ type: "setVariation", field: "seed", value: e.target.value })}
              />
              <Button
                variant="secondary"
                size="sm"
                aria-label={state.variation.seed.trim() === "" ? "Pick a seed" : "Clear the seed"}
                onClick={() =>
                  dispatch({
                    type: "setVariation",
                    field: "seed",
                    value: state.variation.seed.trim() === "" ? String(Math.floor(Math.random() * 0xffffffff)) : "",
                  })
                }
              >
                {state.variation.seed.trim() === "" ? "Pick" : "Clear"}
              </Button>
            </div>
          </Field>
        </div>
        <div className={compact ? "space-y-4" : "grid grid-cols-1 gap-4 sm:grid-cols-2"}>
          <Field
            label="Coverage per product"
            error={errors.perProduct}
            hint="Fewest creatives each product must get"
          >
            <Stepper
              aria-label="Coverage per product"
              min={0}
              max={Math.max(1, Number.parseInt(state.variation.count, 10) || 1)}
              value={state.variation.perProduct}
              invalid={Boolean(errors.perProduct)}
              allowUnset
              unsetLabel="No floor"
              onChange={(value) => dispatch({ type: "setVariation", field: "perProduct", value })}
            />
          </Field>
        </div>
        <RatioAxis state={state} dispatch={dispatch} errors={errors} compact={compact} />
        <AxisCards
          legend="Layout"
          options={LAYOUT_OPTIONS}
          selected={state.variation.layout}
          onToggle={(value) => dispatch({ type: "toggleLayout", value })}
          error={errors.layout}
          compact={compact}
          render={(option) => <CreativeGlyph layout={option} />}
        />
        <AxisCards
          legend="Tone"
          options={TONE_OPTIONS}
          selected={state.variation.tone}
          onToggle={(value) => dispatch({ type: "toggleTone", value })}
          error={errors.tone}
          compact={compact}
          render={(option) => <CreativeGlyph tone={option} />}
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
