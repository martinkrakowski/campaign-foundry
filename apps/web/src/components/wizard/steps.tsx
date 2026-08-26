"use client";

import type { ChangeEvent, Dispatch, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/cn";
import { planCampaign, unknownErrorMessage, uploadAsset, type PlanResult } from "@/lib/briefs-api";
import { dumpBrief } from "./dump-brief";
import type { FieldErrors } from "./validate";
import {
  BACKGROUND_OPTIONS,
  LAYOUT_OPTIONS,
  PALETTE_SHIFT_OPTIONS,
  PLAN_DEBOUNCE_MS,
  STATIC_PLATFORMS,
  TONE_OPTIONS,
  assetFileName,
  canPlan,
  fileToBase64,
  toBrief,
  type WizardAction,
  type WizardState,
  type WizardStepId,
} from "./wizard-state";

export interface StepProps {
  state: WizardState;
  dispatch: Dispatch<WizardAction>;
  errors: FieldErrors;
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="block">
        <span className="mb-1.5 block text-[11px] text-text-muted">{label}</span>
        {children}
      </label>
      {error ? <span className="mt-1 block text-[11px] text-error">{error}</span> : null}
    </div>
  );
}

function ChoiceCard({
  title,
  description,
  selected,
  onClick,
}: {
  title: string;
  description: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "flex flex-col items-start gap-1 rounded-lg border p-4 text-left transition-colors",
        selected ? "border-brand-primary bg-surface-2" : "border-border bg-surface hover:bg-surface-2",
      )}
    >
      <span className="text-sm font-semibold text-white">{title}</span>
      <span className="text-[12px] text-text-muted">{description}</span>
    </button>
  );
}

export function CampaignTypeStep({ state, dispatch, errors }: StepProps) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChoiceCard
          title="Classic"
          description="Product × ratio × treatment matrix. Requires at least two products."
          selected={state.mode === "brief"}
          onClick={() => dispatch({ type: "setMode", mode: "brief" })}
        />
        <ChoiceCard
          title="Randomized"
          description="Seeded variation policy. A single product is allowed."
          selected={state.mode === "variation"}
          onClick={() => dispatch({ type: "setMode", mode: "variation" })}
        />
      </div>
      <Field label="Brief ID" error={errors.briefId}>
        <Input
          value={state.briefId}
          onChange={(e) => dispatch({ type: "patch", patch: { briefId: e.target.value } })}
          invalid={Boolean(errors.briefId)}
        />
      </Field>
    </div>
  );
}

export function ProductsStep({ state, dispatch, errors }: StepProps) {
  const [uploadError, setUploadError] = useState<string | undefined>();

  const onLogoFile = async (index: number, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadError(undefined);
    try {
      const contentBase64 = await fileToBase64(file);
      const { path } = await uploadAsset({
        briefId: state.briefId,
        name: assetFileName(file.name),
        contentBase64,
      });
      dispatch({ type: "setProduct", index, patch: { logoPath: path } });
    } catch (error) {
      setUploadError(unknownErrorMessage(error, "Upload failed"));
    }
    event.target.value = "";
  };

  return (
    <div className="space-y-4">
      {errors.products ? <p className="text-[13px] text-error">{errors.products}</p> : null}
      {uploadError ? <p className="text-[13px] text-error">{uploadError}</p> : null}
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
          Products ({state.products.length})
        </h3>
        <Button variant="secondary" size="sm" onClick={() => dispatch({ type: "addProduct" })}>
          Add product
        </Button>
      </div>
      {state.products.map((product, index) => (
        <div key={index} className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" error={errors[`product-${index}-name`]}>
              <Input
                value={product.name}
                onChange={(e) => dispatch({ type: "setProduct", index, patch: { name: e.target.value } })}
                invalid={Boolean(errors[`product-${index}-name`])}
              />
            </Field>
            <Field label="ID" error={errors[`product-${index}-id`]}>
              <Input
                value={product.id}
                onChange={(e) => dispatch({ type: "setProduct", index, patch: { id: e.target.value } })}
                invalid={Boolean(errors[`product-${index}-id`])}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Primary Colour" error={errors[`product-${index}-color`]}>
              <Input
                value={product.primaryColor}
                onChange={(e) =>
                  dispatch({ type: "setProduct", index, patch: { primaryColor: e.target.value } })
                }
                invalid={Boolean(errors[`product-${index}-color`])}
              />
            </Field>
            <Field label="Logo Path" error={errors[`product-${index}-logo`]}>
              <Input
                value={product.logoPath}
                onChange={(e) => dispatch({ type: "setProduct", index, patch: { logoPath: e.target.value } })}
                invalid={Boolean(errors[`product-${index}-logo`])}
              />
            </Field>
          </div>
          <Field label="Logo file">
            <input
              type="file"
              accept="image/png,image/jpeg"
              className="block w-full text-[12px] text-text-muted file:mr-3 file:rounded-md file:border file:border-border file:bg-surface-2 file:px-3 file:py-1.5 file:text-[12px] file:text-text-primary"
              onChange={(event) => void onLogoFile(index, event)}
            />
          </Field>
          <Field label="Input asset (optional)">
            <Input
              value={product.inputAsset}
              onChange={(e) => dispatch({ type: "setProduct", index, patch: { inputAsset: e.target.value } })}
            />
          </Field>
          <Button variant="ghost" size="sm" onClick={() => dispatch({ type: "removeProduct", index })}>
            Remove
          </Button>
        </div>
      ))}
    </div>
  );
}

export function CopyStep({ state, dispatch, errors }: StepProps) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Target Region" error={errors.targetRegion}>
          <Input
            value={state.targetRegion}
            onChange={(e) => dispatch({ type: "patch", patch: { targetRegion: e.target.value } })}
            invalid={Boolean(errors.targetRegion)}
          />
        </Field>
        <Field label="Target Audience" error={errors.targetAudience}>
          <Input
            value={state.targetAudience}
            onChange={(e) => dispatch({ type: "patch", patch: { targetAudience: e.target.value } })}
            invalid={Boolean(errors.targetAudience)}
          />
        </Field>
      </div>
      <Field label="Campaign Message" error={errors.campaignMessage}>
        <Input
          value={state.campaignMessage}
          onChange={(e) => dispatch({ type: "patch", patch: { campaignMessage: e.target.value } })}
          invalid={Boolean(errors.campaignMessage)}
        />
      </Field>
      <Field label="Localized Message (optional)">
        <Input
          value={state.localizedMessage}
          onChange={(e) => dispatch({ type: "patch", patch: { localizedMessage: e.target.value } })}
        />
      </Field>
    </div>
  );
}

function AxisToggles({
  legend,
  options,
  selected,
  onToggle,
}: {
  legend: string;
  options: readonly string[];
  selected: readonly string[];
  onToggle: (value: string) => void;
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
    </fieldset>
  );
}

function EstimatePanel({ state }: { state: WizardState }) {
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const ready = canPlan(state);

  useEffect(() => {
    if (!ready) {
      setPlan(null);
      return;
    }
    let cancelled = false;
    setPlan(null);
    const timer = window.setTimeout(() => {
      void planCampaign(toBrief(state)).then((result) => {
        if (cancelled) return;
        setPlan(result);
      });
    }, PLAN_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    ready,
    state.briefId,
    state.mode,
    state.products,
    state.variation,
    state.targetRegion,
    state.targetAudience,
    state.campaignMessage,
    state.localizedMessage,
    state.platforms,
  ]);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <h4 className="font-mono text-[11px] uppercase tracking-widest text-text-muted">Estimate</h4>
      {!ready ? (
        <p className="mt-2 text-[13px] text-text-muted">Fill required fields to estimate.</p>
      ) : plan === null ? (
        <p className="mt-2 text-[13px] text-text-muted">Estimating…</p>
      ) : plan.kind === "ok" ? (
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] text-text-primary">
          <dt className="text-text-muted">creatives</dt>
          <dd>{plan.estimate.creatives}</dd>
          <dt className="text-text-muted">axisProductSize</dt>
          <dd>{plan.estimate.axisProductSize}</dd>
          <dt className="text-text-muted">feasible</dt>
          <dd>{plan.estimate.feasible ? "yes" : "no"}</dd>
          <dt className="text-text-muted">genaiCalls</dt>
          <dd>{plan.estimate.genaiCalls}</dd>
        </dl>
      ) : plan.kind === "infeasible" ? (
        <p className="mt-2 text-[13px] text-error">{plan.error}</p>
      ) : (
        <p className="mt-2 text-[13px] text-text-muted">estimate unavailable</p>
      )}
    </div>
  );
}

export function PolicyStep({ state, dispatch, errors }: StepProps) {
  return (
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
        <Field label="Min distance" error={errors.minDistance}>
          <Input
            type="number"
            value={state.variation.minDistance}
            onChange={(e) => dispatch({ type: "setVariation", field: "minDistance", value: e.target.value })}
            invalid={Boolean(errors.minDistance)}
          />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Coverage per product" error={errors.perProduct}>
          <Input
            type="number"
            value={state.variation.perProduct}
            onChange={(e) => dispatch({ type: "setVariation", field: "perProduct", value: e.target.value })}
            invalid={Boolean(errors.perProduct)}
          />
        </Field>
        <Field label="Coverage per ratio" error={errors.perRatio}>
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
      />
      <AxisToggles
        legend="Tone"
        options={TONE_OPTIONS}
        selected={state.variation.tone}
        onToggle={(value) => dispatch({ type: "toggleTone", value })}
      />
      <AxisToggles
        legend="Background source"
        options={BACKGROUND_OPTIONS}
        selected={state.variation.background}
        onToggle={(value) => dispatch({ type: "toggleBackground", value })}
      />
      <fieldset className="space-y-2">
        <legend className="text-[11px] text-text-muted">Palette shift</legend>
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
      </fieldset>
      <EstimatePanel state={state} />
    </div>
  );
}

export function OutputStep({ state, dispatch, errors }: StepProps) {
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-[11px] text-text-muted">Formats</legend>
        <label className="flex items-center gap-2 text-[13px] text-text-primary">
          <input type="checkbox" checked disabled readOnly />
          static
        </label>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-[11px] text-text-muted">Platforms</legend>
        {STATIC_PLATFORMS.map((id) => (
          <label key={id} className="flex items-center gap-2 text-[13px] text-text-primary">
            <input
              type="checkbox"
              checked={state.platforms.includes(id)}
              onChange={() => dispatch({ type: "togglePlatform", value: id })}
            />
            {id}
          </label>
        ))}
        {errors.platforms ? <span className="block text-[11px] text-error">{errors.platforms}</span> : null}
      </fieldset>
    </div>
  );
}

export function ReviewStep({ state }: { state: WizardState }) {
  return (
    <pre className="overflow-x-auto rounded-lg border border-border bg-surface p-4 font-mono text-[12px] text-text-primary">
      {dumpBrief(toBrief(state))}
    </pre>
  );
}

export const STEP_TITLES: Record<WizardStepId, string> = {
  type: "Campaign type",
  products: "Brand & products",
  copy: "Copy",
  policy: "Variation policy",
  output: "Output",
  review: "Review",
};
