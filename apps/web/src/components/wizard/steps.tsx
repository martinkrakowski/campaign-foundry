"use client";

import type { ChangeEvent, Dispatch, ReactNode } from "react";
import { useEffect, useState } from "react";
import { Button, Input } from "@/components/ui";
import { cn } from "@/lib/cn";
import {
  generatePool,
  getPool,
  isBriefsApiError,
  patchPool,
  planCampaign,
  unknownErrorMessage,
  uploadAsset,
  POOL_SUGGESTION_COUNT,
  type CopyPool,
  type CopyPoolEntry,
  type PlanResult,
} from "@/lib/briefs-api";
import { dumpBrief } from "./dump-brief";
import type { FieldErrors } from "./validate";
import {
  BACKGROUND_OPTIONS,
  HEADLINE_POOL_REF,
  LAYOUT_OPTIONS,
  PALETTE_SHIFT_OPTIONS,
  PLAN_DEBOUNCE_MS,
  STATIC_PLATFORMS,
  TONE_OPTIONS,
  approvedHeadlines,
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
  const [uploadingKeys, setUploadingKeys] = useState<ReadonlySet<number>>(new Set());

  const onLogoFile = async (key: number, productId: string, event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadError(undefined);
    setUploadingKeys((prev) => new Set(prev).add(key));
    const name = assetFileName(file.name, productId);
    try {
      const contentBase64 = await fileToBase64(file);
      const { path } = await uploadAsset({
        briefId: state.briefId,
        name,
        contentBase64,
      });
      dispatch({ type: "setProduct", key, patch: { logoPath: path } });
    } catch (error) {
      if (isBriefsApiError(error) && error.status === 409) {
        dispatch({
          type: "setProduct",
          key,
          patch: { logoPath: `assets/inputs/${state.briefId}/${name}` },
        });
      } else {
        setUploadError(unknownErrorMessage(error, "Upload failed"));
      }
    } finally {
      setUploadingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
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
        <div key={product.key} className="space-y-3 rounded-lg border border-border bg-surface p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" error={errors[`product-${index}-name`]}>
              <Input
                value={product.name}
                onChange={(e) =>
                  dispatch({ type: "setProduct", key: product.key, patch: { name: e.target.value } })
                }
                invalid={Boolean(errors[`product-${index}-name`])}
              />
            </Field>
            <Field label="ID" error={errors[`product-${index}-id`]}>
              <Input
                value={product.id}
                onChange={(e) =>
                  dispatch({ type: "setProduct", key: product.key, patch: { id: e.target.value } })
                }
                invalid={Boolean(errors[`product-${index}-id`])}
              />
            </Field>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Primary Colour" error={errors[`product-${index}-color`]}>
              <Input
                value={product.primaryColor}
                onChange={(e) =>
                  dispatch({
                    type: "setProduct",
                    key: product.key,
                    patch: { primaryColor: e.target.value },
                  })
                }
                invalid={Boolean(errors[`product-${index}-color`])}
              />
            </Field>
            <Field label="Logo Path" error={errors[`product-${index}-logo`]}>
              <Input
                value={product.logoPath}
                onChange={(e) =>
                  dispatch({ type: "setProduct", key: product.key, patch: { logoPath: e.target.value } })
                }
                invalid={Boolean(errors[`product-${index}-logo`])}
              />
            </Field>
          </div>
          <Field label="Logo file">
            <input
              type="file"
              accept="image/png,image/jpeg"
              className="block w-full text-[12px] text-text-muted file:mr-3 file:rounded-md file:border file:border-border file:bg-surface-2 file:px-3 file:py-1.5 file:text-[12px] file:text-text-primary"
              onChange={(event) => void onLogoFile(product.key, product.id, event)}
            />
          </Field>
          <Field label="Input asset (optional)">
            <Input
              value={product.inputAsset}
              onChange={(e) =>
                dispatch({ type: "setProduct", key: product.key, patch: { inputAsset: e.target.value } })
              }
            />
          </Field>
          <Button
            variant="ghost"
            size="sm"
            disabled={uploadingKeys.has(product.key)}
            onClick={() => dispatch({ type: "removeProduct", key: product.key })}
          >
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
      {state.mode === "variation" ? <HeadlinePoolPanel state={state} dispatch={dispatch} /> : null}
    </div>
  );
}

function PoolEntryRow({
  entry,
  busy,
  onStatus,
  onEdit,
}: {
  entry: CopyPoolEntry;
  busy: boolean;
  onStatus: (status: CopyPoolEntry["status"]) => void;
  onEdit: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const approved = entry.status === "approved";

  const save = async (text: string) => {
    if (await onEdit(text)) setDraft(null);
  };

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2">
      {draft === null ? (
        <span className="min-w-0 flex-1 text-[13px] text-text-primary">{entry.text}</span>
      ) : (
        <Input
          aria-label={`Edit ${entry.id}`}
          className="min-w-0 flex-1"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      <span
        className={cn(
          "font-mono text-[11px] uppercase tracking-widest",
          approved ? "text-success" : "text-error",
        )}
      >
        {entry.status}
      </span>
      {entry.reason ? <span className="text-[11px] text-text-muted">{entry.reason}</span> : null}
      {draft === null ? (
        <>
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={approved}
            aria-label={`${approved ? "Reject" : "Approve"} ${entry.id}`}
            disabled={busy}
            onClick={() => onStatus(approved ? "rejected" : "approved")}
          >
            {approved ? "Reject" : "Approve"}
          </Button>
          <Button variant="ghost" size="sm" aria-label={`Edit ${entry.id}`} disabled={busy} onClick={() => setDraft(entry.text)}>
            Edit
          </Button>
        </>
      ) : (
        <>
          <Button size="sm" aria-label={`Save ${entry.id}`} disabled={busy || draft.trim() === ""} onClick={() => void save(draft)}>
            Save
          </Button>
          <Button variant="ghost" size="sm" aria-label={`Cancel ${entry.id}`} disabled={busy} onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </>
      )}
    </li>
  );
}

/**
 * Headline pool — the HITL surface for `headline: pool://copy`. Loads the
 * brief's pool, lets the user generate suggestions (legal-gated server-side),
 * approve/reject, and edit (an edit re-runs the legal gate on the API).
 */
function HeadlinePoolPanel({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  const { briefId, pool } = state;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [unavailable, setUnavailable] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    getPool(briefId, controller.signal)
      .then((loaded) => {
        if (!cancelled) dispatch({ type: "setPool", pool: loaded });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(unknownErrorMessage(cause, "Could not load the headline pool"));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [briefId, dispatch]);

  /** Apply one pool change; a 503 (no OPENROUTER_API_KEY) pins the API's message and disables generation. */
  const apply = async (change: () => Promise<CopyPool>): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      dispatch({ type: "setPool", pool: await change() });
      return true;
    } catch (cause) {
      if (isBriefsApiError(cause) && cause.status === 503) setUnavailable(cause.message);
      else setError(unknownErrorMessage(cause, "Headline pool update failed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const entries = pool?.entries ?? [];
  const approved = approvedHeadlines(pool);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
          Headline pool ({approved} approved)
        </h4>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || unavailable !== undefined}
          isLoading={busy}
          onClick={() => void apply(async () => (await generatePool(briefId)).pool)}
        >
          Generate {POOL_SUGGESTION_COUNT} suggestions
        </Button>
      </div>
      <p className="text-[12px] text-text-muted">
        Approved entries become the <code>headline: {HEADLINE_POOL_REF}</code> axis in the policy step.
      </p>
      {unavailable ? <p className="text-[13px] text-warning">{unavailable}</p> : null}
      {error ? <p className="text-[13px] text-error">{error}</p> : null}
      {entries.length === 0 ? (
        <p className="text-[13px] text-text-muted">No headlines yet.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <PoolEntryRow
              key={entry.id}
              entry={entry}
              busy={busy}
              onStatus={(status) => void apply(() => patchPool(briefId, [{ id: entry.id, status }]))}
              onEdit={(text) => apply(() => patchPool(briefId, [{ id: entry.id, status: entry.status, text }]))}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

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

function EstimatePanel({ state }: { state: WizardState }) {
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const ready = canPlan(state);

  useEffect(() => {
    if (!ready) {
      setPlan(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setPlan(null);
    const timer = window.setTimeout(() => {
      void planCampaign(toBrief(state), controller.signal).then((result) => {
        if (cancelled) return;
        setPlan(result);
      });
    }, PLAN_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      controller.abort();
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
    state.pool,
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

/** Shown while the headline axis is blocked for want of an approved entry. */
const HEADLINE_POOL_EMPTY =
  "The headline pool has no approved entries — approve at least one in the Copy step.";

/**
 * The `headline` axis: on only when the pool has an approved entry to draw from.
 * No field error is needed — the reducer switches the axis off whenever the pool
 * loses its last approved entry, so an on-but-empty state cannot reach validation.
 */
function HeadlineAxisToggle({ state, dispatch }: { state: WizardState; dispatch: Dispatch<WizardAction> }) {
  const approved = approvedHeadlines(state.pool);
  const blocked = approved === 0;
  const on = state.variation.headline;
  return (
    <fieldset className="space-y-2">
      <legend className="text-[11px] text-text-muted">Headline</legend>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={on}
          disabled={blocked}
          onClick={() => dispatch({ type: "toggleHeadline" })}
          className={cn(
            "rounded-md border px-3 py-1.5 font-mono text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            on ? "border-brand-primary bg-surface-2 text-white" : "border-border text-text-muted",
          )}
        >
          {HEADLINE_POOL_REF}
        </button>
        <span className="text-[11px] text-text-muted">
          {blocked ? HEADLINE_POOL_EMPTY : `${approved} approved headline${approved === 1 ? "" : "s"}`}
        </span>
      </div>
    </fieldset>
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
        legend="Background source"
        options={BACKGROUND_OPTIONS}
        selected={state.variation.background}
        onToggle={(value) => dispatch({ type: "toggleBackground", value })}
        error={errors.background}
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
        {errors.paletteShift ? (
          <span className="block text-[11px] text-error">{errors.paletteShift}</span>
        ) : null}
      </fieldset>
      <HeadlineAxisToggle state={state} dispatch={dispatch} />
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
