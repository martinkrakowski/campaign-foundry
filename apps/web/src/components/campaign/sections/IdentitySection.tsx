"use client";

import { useId, useState, useRef, useEffect, useCallback, useMemo, type Dispatch } from "react";
import { Input, ChipGroup, WorldMap, REGION_FOOTPRINTS, MAP_WIDTH, MAP_HEIGHT } from "@/components/ui";
import type { EditorState, EditorAction } from "@/components/campaign/editor-state";
import type { FieldErrors } from "@/components/campaign/validate";
import { keyForLabel } from "@/components/campaign/error-sections";
import { ErrorPill } from "@/components/ui";
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
  warning,
  hint,
  children,
  fieldKey,
  as = "label",
}: {
  label: string;
  error?: string;
  warning?: string;
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
      {error ? (
        <span className="mt-1 block text-[11px] text-error">{error}</span>
      ) : warning ? (
        <span className="mt-1 block text-[11px] text-warning">{warning}</span>
      ) : null}
    </div>
  );
}

export function IdentitySection({
  state,
  dispatch,
  errors,
  compact = false,
}: SectionProps & { compact?: boolean }) {
  const readOnly = state.source.kind === "file";
  const [copied, setCopied] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  // The matrix is hundreds of SVG nodes. Paint it after the first frame, not in
  // this effect's body: a layout-effect dispatch (the create seed) flushes
  // pending passive effects before paint, which would otherwise build the map
  // on the first frame the chips were meant to own.
  useEffect(() => {
    const show = () => setMapReady(true);
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(show);
      return () => cancelAnimationFrame(frame);
    }
    const timer = setTimeout(show, 0);
    return () => clearTimeout(timer);
  }, []);

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

  const onSelectRegion = useCallback(
    (value: string) => dispatch({ type: "patch", patch: { targetRegion: value } }),
    [dispatch],
  );

  // The map's SVG is hundreds of nodes. An inline `onSelect` rebuilds the
  // element on every editor update (keystroke, save-flow step) and happy-dom
  // repaints the whole matrix. Memoize on the value it displays.
  const mapValue = (REGION_OPTIONS as readonly string[]).includes(state.targetRegion)
    ? state.targetRegion
    : null;
  const worldMap = useMemo(
    () => (
      <WorldMap
        footprints={REGION_FOOTPRINTS}
        value={mapValue}
        onSelect={onSelectRegion}
        labelFor={messages.regionDisplayName}
        fallbackHint={messages.worldMapFallbackHint}
      />
    ),
    [mapValue, onSelectRegion, REGION_FOOTPRINTS, messages.regionDisplayName, messages.worldMapFallbackHint],
  );

  return (
    <SectionShell id="identity" title="1 · Identity" errorCount={countErrors(errors)} compact={compact}>
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
              // The label must be stated in BOTH states, not dropped when copied. This
              // button sits inside `Field`'s <label>, and with no aria-label of its own
              // its computed name comes out as the field's text — measured here as
              // "Campaign Name camp-summer camp-summer", not "Copied ✓". So the copied
              // state names itself explicitly, from the same constant it renders, which
              // is what lets the confirmation be announced and keeps the accessible name
              // containing the visible text (WCAG 2.5.3) in both states.
              aria-label={copied ? messages.briefIdCopied : messages.briefIdCopyAria}
            >
              {copied ? messages.briefIdCopied : messages.briefIdCopy}
            </button>
          </div>
        </Field>
        <Field fieldKey="targetRegion" label={messages.targetRegionLabel} error={errors.targetRegion} as="div">
          {/* F4/D94 — the map and the chips are two views of one value, both bound
           * to `targetRegion`. The wiring is M2's, carried over from the dialog:
           * the SVG is aria-hidden and adds no focusable element, so the chips
           * stay the accessible and keyboard control, and a free-text region
           * (Other…) paints no footprint. The compact form (the 320 px sidebar)
           * renders the chips alone — a 960×500 map cannot go there. */}
          <div className={compact ? undefined : "space-y-2"}>
            {!compact ? (
              <>
                {mapReady ? (
                  worldMap
                ) : (
                  <div
                    aria-hidden="true"
                    className="w-full"
                    style={{ aspectRatio: `${MAP_WIDTH} / ${MAP_HEIGHT}` }}
                  />
                )}
                <p className="text-[12px] text-text-muted">{messages.worldMapRegionHint}</p>
              </>
            ) : null}
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
          </div>
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
