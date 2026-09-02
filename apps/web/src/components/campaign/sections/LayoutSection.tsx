"use client";

import { useMemo, type ReactNode } from "react";
import { RATIO_DIMENSIONS } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import {
  ALIGN_VALUES,
  DEFAULT_STYLE,
  FONT_FAMILY_VALUES,
  FONT_WEIGHT_VALUES,
  MAX_LETTER_SPACING,
  MAX_LINE_HEIGHT,
  MAX_SIZE_SCALE,
  MIN_LETTER_SPACING,
  MIN_LINE_HEIGHT,
  MIN_SIZE_SCALE,
  TEXT_EFFECT_VALUES,
  type AlignKind,
  type FontWeightKind,
} from "@campaignfoundry/CampaignOrchestration/creative-style";
import { ChipGroup, Slider } from "@/components/ui";
import { toBrief, type EditorState } from "@/components/campaign/editor-state";
import { derivePreviewRatio } from "@/components/campaign/PreviewDock";
import { PreviewFrame } from "@/components/campaign/PreviewFrame";
import { previewLook } from "@/components/campaign/preview-props";
import {
  platformDisplayName,
  ratioDisplayName,
  TEXT_EFFECT_META,
  textEffectDisplayName,
} from "@/components/campaign/display-names";
import { briefBackgroundIsStandIn } from "@/lib/preview-frame";
import * as messages from "@/components/campaign/messages";
import { SectionShell, Field, type SectionProps } from "./IdentitySection";

/**
 * Display labels for the single-select style vocabularies, keyed by the
 * domain's own values (D18) — a new member of the leaf's vocabulary is a
 * compile error here rather than an unlabelled chip. `choices` derives both
 * the chip faces and the parse back to the domain's value from the one map,
 * so the two can never drift.
 */
function choices<V extends string | number>(vocabulary: readonly V[], label: (value: V) => string) {
  const byLabel = new Map<string, V>(vocabulary.map((value) => [label(value), value]));
  return {
    options: [...byLabel.keys()],
    // ChipGroup without its Other escape can only hand back a face it rendered,
    // so the parse is total for everything the control can say.
    parse: (face: string) => byLabel.get(face) as V,
  };
}

const FAMILY_CHOICES = choices(FONT_FAMILY_VALUES, (value) => value);
const WEIGHT_LABELS: Record<FontWeightKind, string> = { 400: "Regular", 700: "Bold" };
const WEIGHT_CHOICES = choices(FONT_WEIGHT_VALUES, (weight) => WEIGHT_LABELS[weight]);
const ALIGN_LABELS: Record<AlignKind, string> = { left: "Left", center: "Center", right: "Right" };
const ALIGN_CHOICES = choices(ALIGN_VALUES, (align) => ALIGN_LABELS[align]);
const EFFECT_CHOICES = choices(TEXT_EFFECT_VALUES, (value) => TEXT_EFFECT_META[value]);
/**
 * The Effect row is single-choice with "None" (T6): the four kinds plus the
 * absent field, whose face is the one label with no kind behind it. `parse` is
 * total over the faces the group renders because the "None" face is handled at
 * the dispatch site — it patches `textEffect: undefined`, the absent key.
 */
const EFFECT_NONE = messages.styleEffectNone;
const EFFECT_OPTIONS = [EFFECT_NONE, ...EFFECT_CHOICES.options];

/**
 * D60: absent `fontWeight` follows the tone-derived RENDERED face — `subtle`
 * asks "500" and renders Regular (400); `bold` renders 700. The treatment's
 * tone lives in the same state (classic: first treatment; randomized: first
 * axis value); anything that is not `subtle` is the compositor's bold path.
 */
function toneRenderedWeight(state: EditorState): FontWeightKind {
  const tone = state.mode === "brief" ? state.treatments[0]?.tone : state.variation.tone[0];
  return tone === "subtle" ? 400 : 700;
}

/** The readout span the sliders wear — one style, three sliders. */
function Readout({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="shrink-0 rounded-md border border-border px-2 py-0.5 font-mono text-[12px] tabular-nums text-text-primary">
      {children}
    </span>
  );
}

/**
 * The Layout step (T7 — D62/D63): the template's home in the wizard. The
 * T5 `style` block — family, weight, size, line height, letter spacing and
 * alignment, each bounded by the Style VO's own constants — with the real
 * compositor frame (`PreviewFrame`, D52) beside it at the previewed ratio,
 * updating as the user authors.
 *
 * It renders in BOTH modes — the template is brief-level — and reuses the
 * existing panels where they exist rather than duplicating them: in Randomized
 * the lock-or-vary axis cards stay on Variation Policy (one surface per job,
 * D63), and in Classic the layout/tone treatment choice keeps its own step,
 * whose look this step's frame previews.
 *
 * The frame is step-scoped (D63): the guided walk mounts it, and because the
 * step carries its own preview the rail is suppressed here exactly as on
 * Review — exactly one composed preview on screen (D43). The Everything stack
 * mounts the controls only (`preview` absent), where no composed preview
 * surface exists by design.
 */
export function LayoutSection({ state, dispatch, errors, preview = false }: SectionProps & { preview?: boolean }) {
  // The projection the frame is fed (D26/D45): exactly what Save will send, so
  // the preview can never show a style the brief would not carry.
  const brief = useMemo(() => toBrief(state), [state]);
  const look = previewLook(state);
  // One derivation, once (§6 question 4): the platform's own ratio wins, a
  // square otherwise — the same answer the dock and the Review figure give.
  const ratio = derivePreviewRatio(look?.platformId, undefined);
  const style = state.style;
  const sizeScale = style.sizeScale ?? DEFAULT_STYLE.sizeScale;
  const lineHeight = style.lineHeight ?? DEFAULT_STYLE.lineHeight;
  const letterSpacing = style.letterSpacing ?? DEFAULT_STYLE.letterSpacing;
  // D55: the size is stored as a fraction of the canvas width and DISPLAYED as
  // the pixels it means at the previewed ratio — derived text, never stored.
  const sizePx = Math.round(sizeScale * RATIO_DIMENSIONS[ratio].width);
  const platformLabel =
    look?.platformId !== undefined ? platformDisplayName(look.platformId) : messages.previewNoPlatform;
  // The caption names the effect when the template carries one (T6, the D50
  // pattern): the frame is the effect's REST pose, so the name in words — a
  // display label, never a raw kind id — is what says the video animates.
  const caption =
    brief.style?.textEffect !== undefined
      ? messages.previewCaptionTextEffect(
          ratioDisplayName(ratio),
          platformLabel,
          textEffectDisplayName(brief.style.textEffect),
        )
      : messages.previewCaption(ratioDisplayName(ratio), platformLabel);
  const captionText = briefBackgroundIsStandIn(brief)
    ? `${caption} · ${messages.previewFrameStandInBackground}`
    : caption;

  const frame: ReactNode =
    preview && look !== null ? (
      <figure className="flex flex-col gap-2">
        {/* T1b: the frame is the REAL composited creative, the SVG until it arrives. */}
        <PreviewFrame
          brief={brief}
          layout={look.layout}
          tone={look.tone}
          anchor={look.anchor}
          style={look.style}
          primaryColor={look.primaryColor}
          headline={look.headline}
          motion={look.motion}
          ratio={ratio}
          className="block h-auto w-full"
        />
        <figcaption className="font-mono text-[11px] text-text-muted">{captionText}</figcaption>
      </figure>
    ) : null;

  return (
    <SectionShell id="layout" title="Layout" errorCount={Object.keys(errors).length}>
      <div
        className={
          frame !== null ? "grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:items-start" : "space-y-6"
        }
      >
        <div className="space-y-6">
          <fieldset className="space-y-4">
            <legend className="text-[11px] text-text-muted">Type</legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label="Typeface" hint="From the faces the renderer bundles">
                <ChipGroup
                  label="Typeface"
                  options={FAMILY_CHOICES.options}
                  value={style.fontFamily ?? DEFAULT_STYLE.fontFamily}
                  onChange={(value) => dispatch({ type: "setStyle", patch: { fontFamily: FAMILY_CHOICES.parse(value) } })}
                />
              </Field>
              <Field label="Weight" hint="Only the weights that have faces">
                <ChipGroup
                  label="Weight"
                  options={WEIGHT_CHOICES.options}
                  value={WEIGHT_LABELS[style.fontWeight ?? toneRenderedWeight(state)]}
                  onChange={(value) => dispatch({ type: "setStyle", patch: { fontWeight: WEIGHT_CHOICES.parse(value) } })}
                />
              </Field>
              <Field label="Alignment">
                <ChipGroup
                  label="Alignment"
                  options={ALIGN_CHOICES.options}
                  value={ALIGN_LABELS[style.align ?? DEFAULT_STYLE.align]}
                  onChange={(value) => dispatch({ type: "setStyle", patch: { align: ALIGN_CHOICES.parse(value) } })}
                />
              </Field>
            </div>
            <Field label="Effect" hint="An entrance for the headline — the preview shows its final pose">
              <ChipGroup
                label="Effect"
                options={EFFECT_OPTIONS}
                value={
                  style.textEffect !== undefined ? TEXT_EFFECT_META[style.textEffect] : EFFECT_NONE
                }
                onChange={(value) =>
                  dispatch({
                    type: "setStyle",
                    patch: { textEffect: value === EFFECT_NONE ? undefined : EFFECT_CHOICES.parse(value) },
                  })
                }
              />
            </Field>
            <Field label="Size" hint="A share of the canvas width, shown as pixels at the previewed ratio">
              <Slider
                aria-label="Size"
                min={MIN_SIZE_SCALE}
                max={MAX_SIZE_SCALE}
                step={0.005}
                value={sizeScale}
                readout={<Readout>{messages.styleSizeReadout(sizePx, ratioDisplayName(ratio))}</Readout>}
                onChange={(value) => dispatch({ type: "setStyle", patch: { sizeScale: value } })}
              />
            </Field>
            <Field label="Line height" hint="A multiple of the type size">
              <Slider
                aria-label="Line height"
                min={MIN_LINE_HEIGHT}
                max={MAX_LINE_HEIGHT}
                step={0.05}
                value={lineHeight}
                readout={<Readout>{lineHeight.toFixed(2)}</Readout>}
                onChange={(value) => dispatch({ type: "setStyle", patch: { lineHeight: value } })}
              />
            </Field>
            <Field label="Letter spacing" hint="A share of the type size, per letter">
              <Slider
                aria-label="Letter spacing"
                min={MIN_LETTER_SPACING}
                max={MAX_LETTER_SPACING}
                step={0.01}
                value={letterSpacing}
                readout={<Readout>{`${letterSpacing.toFixed(2)} em`}</Readout>}
                onChange={(value) => dispatch({ type: "setStyle", patch: { letterSpacing: value } })}
              />
            </Field>
          </fieldset>
        </div>
        {frame}
      </div>
    </SectionShell>
  );
}
