"use client";

import { useId } from "react";
import type { Dispatch, ReactNode } from "react";
import { RATIO_DIMENSIONS, RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import {
  AxisCard,
  Button,
  CreativeGlyph,
  Disclosure,
  Input,
  PreviewCard,
  Slider,
  Stepper,
  SwatchChip,
  SwitchRow,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import * as messages from "@/components/campaign/messages";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import { RATIO_OPTIONS } from "@/components/campaign/editor-state";
import { RatioPanel } from "@/components/campaign/RatioPanel";
import { ratioDisplayName } from "@/components/campaign/display-names";
import {
  axisProductSize,
  drawableRatios,
  maxMinDistance,
  motionPackagedRatios,
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
  // The same motion narrowing the policy applies: a motion-only plan draws only
  // the ratios its requested platforms package.
  const motionOnly = state.formats.includes("motion") && !state.formats.includes("static");
  const packaged = motionPackagedRatios(state);
  const motionRatios = RATIO_OPTIONS.filter((ratio) => packaged.has(ratio));
  const ratioFloorTotal = floor * drawable.length;
  // Mirrors the planner's refusal (perRatio × ratios it will draw > count), so
  // the coupling surfaces before the run instead of as a shortfall error after.
  const over = floor > 0 && ratioFloorTotal > count;

  const shapesHintId = useId();
  const derivedShapes = !state.ratioOverridden;
  return (
    // The hint explains where these shapes came from, so it belongs to the group rather
    // than sitting beside it: a screen-reader user meeting the fieldset should hear it too.
    <fieldset className="space-y-2" {...(derivedShapes ? { "aria-describedby": shapesHintId } : {})}>
      <legend className="text-[11px] text-text-muted">
        Aspect ratios{" "}
        {derivedShapes ? <span id={shapesHintId}>{`· ${messages.shapesFromPlatforms}`}</span> : null}
      </legend>
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
            floor={floor}
            onToggle={(value) => dispatch({ type: "toggleRatio", value })}
          />
        ))}
      </div>
      {motionOnly && packaged.size < RATIO_VALUES.length ? (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-warning">
          <span>
            {motionRatios.length > 0
              ? messages.ratioExcludedPackaged(motionRatios.map(ratioDisplayName))
              : messages.ratioExcludedNone()}
          </span>
          <button
            type="button"
            onClick={() => dispatch({ type: "toggleFormat", value: "static" })}
            className="underline hover:text-text-primary"
          >
            {messages.turnOnStillImages}
          </button>
        </div>
      ) : null}
      {errors.ratio ? <span className="block text-[11px] text-error">{errors.ratio}</span> : null}
    </fieldset>
  );
}

/**
 * What each background source paints, at chip size. Pictures rather than the bare
 * enum: "procedural" means nothing until you see the pattern it draws (D6).
 */
const BACKGROUND_PREVIEW: Record<(typeof BACKGROUND_OPTIONS)[number], { readonly meta: string; readonly paint: ReactNode }> = {
  procedural: {
    meta: "A pattern we draw",
    paint: (
      <span className="block size-10 overflow-hidden rounded-md border border-border">
        <svg viewBox="0 0 40 40" focusable="false" aria-hidden="true" className="size-full">
          <rect width="40" height="40" fill="var(--color-surface-2)" />
          {[0, 10, 20, 30].map((x) =>
            [0, 10, 20, 30].map((y) => (
              <circle key={`${x}-${y}`} cx={x + 5} cy={y + 5} r="2.5" fill="var(--color-brand-primary)" opacity="0.55" />
            )),
          )}
        </svg>
      </span>
    ),
  },
  "asset-pool": {
    meta: "Your own images",
    paint: (
      <span className="block size-10 overflow-hidden rounded-md border border-border">
        <svg viewBox="0 0 40 40" focusable="false" aria-hidden="true" className="size-full">
          <rect width="40" height="40" fill="var(--color-surface-2)" />
          <path d="M4 30l9-11 7 8 5-5 11 12z" fill="var(--color-brand-primary)" opacity="0.6" />
          <circle cx="28" cy="12" r="4" fill="var(--color-brand-primary)" opacity="0.8" />
        </svg>
      </span>
    ),
  },
  genai: {
    meta: "Made by AI",
    paint: (
      <span className="block size-10 overflow-hidden rounded-md border border-border">
        <svg viewBox="0 0 40 40" focusable="false" aria-hidden="true" className="size-full">
          <rect width="40" height="40" fill="var(--color-surface-2)" />
          <path
            d="M20 8l2.6 7.4L30 18l-7.4 2.6L20 28l-2.6-7.4L10 18l7.4-2.6z"
            fill="var(--color-brand-primary)"
            opacity="0.85"
          />
        </svg>
      </span>
    ),
  },
};

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
    <SwitchRow
      label={HEADLINE_POOL_REF}
      checked={on}
      disabled={disabled}
      onToggle={() => dispatch({ type: "toggleHeadline" })}
    >
      {!poolLoaded
        ? "Headline pool not loaded. Open the headline drawer to view available headlines."
        : !hasApproved
          ? HEADLINE_POOL_EMPTY
          : `${approvedCount} approved headline${approvedCount === 1 ? "" : "s"}`}
    </SwitchRow>
  );
}

export function PolicySection({ state, dispatch, errors, compact = false }: { state: EditorState; dispatch: Dispatch<EditorAction>; errors: FieldErrors; compact?: boolean }) {
  if (state.mode !== "variation") return null;
  const axisMax = axisProductSize(state);

  return (
    <SectionShell id="policy" title="4 · Variation Policy" errorCount={Object.keys(errors).length} compact={compact}>
      <div className="space-y-6">
        <div className="space-y-4">
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
              readout={
                <span
                  className={cn(
                    "shrink-0 rounded-md border px-2 py-0.5 text-[12px] tabular-nums",
                    errors.count ? "border-error text-error" : "border-border text-text-primary",
                  )}
                >
                  {messages.countReadout(Number.parseInt(state.variation.count, 10) || 0, axisMax)}
                </span>
              }
              onChange={(value) => dispatch({ type: "setVariation", field: "count", value: String(value) })}
            />
            {/* L2.2: the clamp is not silent. It says the number moved and why, once —
                the next thing the user does to the count takes it down. */}
            {state.countNotice === null ? null : (
              <p role="status" className="mt-1 text-[11px] text-text-muted">
                {messages.countLowered(state.countNotice)}
              </p>
            )}
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
        {/* D6: five things up front, the rest behind one door that remembers it was
            opened. Nothing here is required to plan a campaign. */}
        <Disclosure id="policy-advanced" title="Advanced">
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
                // the Field label wraps both this input and the Pick button, so it names
                // neither on its own — the input carries its own name.
                aria-label="Seed"
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
        <fieldset className="space-y-2">
          <legend className="text-[11px] text-text-muted">Background Source</legend>
          <div className="space-y-2">
            {BACKGROUND_OPTIONS.map((option) => (
              <PreviewCard
                key={option}
                value={option}
                selected={state.variation.background.includes(option)}
                meta={BACKGROUND_PREVIEW[option].meta}
                onToggle={(value: string) =>
                  dispatch({ type: "toggleBackground", value: value as (typeof BACKGROUND_OPTIONS)[number] })
                }
              >
                {BACKGROUND_PREVIEW[option].paint}
              </PreviewCard>
            ))}
          </div>
          {errors.background ? <span className="block text-[11px] text-error">{errors.background}</span> : null}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="text-[11px] text-text-muted">Palette Shift</legend>
          <div className="flex flex-wrap gap-2">
            {PALETTE_SHIFT_OPTIONS.map((option) => (
              <SwatchChip
                key={option}
                value={option}
                selected={state.variation.paletteShift.includes(option)}
                baseColor={state.products[0]?.primaryColor ?? "#1473E6"}
                onToggle={(value: number) => dispatch({ type: "togglePalette", value })}
              />
            ))}
          </div>
          {errors.paletteShift ? (
            <span className="block text-[11px] text-error">{errors.paletteShift}</span>
          ) : null}
        </fieldset>
          <HeadlineAxisToggle state={state} dispatch={dispatch} />
        </Disclosure>
      </div>
    </SectionShell>
  );
}
