import type { ReactNode } from "react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import type { MotionKind } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import { RATIO_DIMENSIONS, type AspectRatioValue } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import type { LayoutOption, ToneOption, AnchorOption } from "./CreativePreview";
import { derivePreviewRatio } from "./PreviewDock";
import { PreviewFrame } from "./PreviewFrame";
import {
  alignDisplayName,
  formatDisplayName,
  platformDisplayName,
  ratioDisplayName,
  weightDisplayName,
} from "./display-names";
import { briefBackgroundIsStandIn } from "@/lib/preview-frame";
import { SECTION_TITLES, sectionOrder, type SectionId } from "./sections";
import * as messages from "./messages";

/** The first entry of an optional list — undefined with the list, never a crash. */
function firstOf<T>(list: readonly T[] | undefined): T | undefined {
  return list?.[0];
}

/** One summary row: the section it edits and the lines the projection carries for it. */
interface SummaryRow {
  readonly section: SectionId;
  readonly lines: readonly string[];
}

/**
 * The summary rows, generated from the brief the caller passes — the same `toBrief`
 * projection Apply and Save send (W8.1). Review shows what will actually be
 * submitted, so a field the projection omits takes its row with it: `treatments`
 * on a classic draft without any, the `output` block when the defaults say nothing.
 * The rows walk `sectionOrder` of the brief's own mode, and every row title is the
 * one `SECTION_TITLES` vocabulary — no second list lives here.
 */
function summaryRows(brief: CampaignBrief, ratio: AspectRatioValue): SummaryRow[] {
  const rows: SummaryRow[] = [];
  for (const section of sectionOrder(brief.mode ?? "brief")) {
    switch (section) {
      case "identity":
        rows.push({
          section,
          lines: [
            `${messages.reviewRowId}: ${brief.id}`,
            `${messages.reviewRowTargetRegion}: ${brief.targetRegion}`,
            `${messages.reviewRowTargetAudience}: ${brief.targetAudience}`,
          ],
        });
        break;
      case "copy":
        rows.push({
          section,
          lines: [
            `${messages.reviewRowCampaignMessage}: ${brief.campaignMessage}`,
            ...(brief.localizedMessage !== undefined
              ? [`${messages.reviewRowLocalizedMessage}: ${brief.localizedMessage}`]
              : []),
          ],
        });
        break;
      case "products":
        rows.push({
          section,
          lines: [messages.joinList(brief.products.map((product) => product.name))],
        });
        break;
      case "treatments":
        // Content, not presence: an empty list would join to a blank line, and a
        // blank row is the same wrongness as a missing one (W8.1's contract).
        if (brief.treatments !== undefined && brief.treatments.length > 0) {
          rows.push({
            section,
            lines: [messages.joinList(brief.treatments.map((treatment) => treatment.id))],
          });
        }
        break;
      case "output": {
        const formats = brief.output?.formats;
        const platforms = brief.output?.platforms;
        if (
          formats !== undefined &&
          formats.length > 0 &&
          platforms !== undefined &&
          platforms.length > 0
        ) {
          rows.push({
            section,
            lines: [
              messages.joinList(formats.map(formatDisplayName)),
              messages.joinList(platforms.map(platformDisplayName)),
            ],
          });
        }
        break;
      }
      case "policy":
        if (brief.variation?.count !== undefined) {
          rows.push({ section, lines: [messages.reviewPolicyValue(brief.variation.count)] });
        }
        break;
      case "layout": {
        // The template row (T7): the brief's authored type, in display labels
        // (D18), the size in derived px at this row's own ratio (D55). Content,
        // not presence: a brief that carries no style block gets no row (W8.1).
        const style = brief.style;
        if (style !== undefined) {
          const lines = [
            ...(style.fontFamily !== undefined ? [messages.reviewStyleFamily(style.fontFamily)] : []),
            ...(style.fontWeight !== undefined
              ? [messages.reviewStyleWeight(weightDisplayName(style.fontWeight))]
              : []),
            ...(style.sizeScale !== undefined
              ? [messages.styleSizeReadout(Math.round(style.sizeScale * RATIO_DIMENSIONS[ratio].width), ratioDisplayName(ratio))]
              : []),
            ...(style.lineHeight !== undefined ? [messages.reviewStyleLineHeight(style.lineHeight.toFixed(2))] : []),
            ...(style.letterSpacing !== undefined
              ? [messages.reviewStyleLetterSpacing(style.letterSpacing.toFixed(2))]
              : []),
            ...(style.align !== undefined ? [messages.reviewStyleAlign(alignDisplayName(style.align))] : []),
          ];
          rows.push({ section, lines });
        }
        break;
      }
    }
  }
  return rows;
}

/**
 * The review step (W8.1): the creative the compositor will draw beside one summary
 * row per section, each with an Edit control that hands the section id to the
 * editor's reveal — which switches the step and scrolls once the target has mounted.
 * The preview is W9's `CreativePreview`, fed from the projection alone (D26): the
 * first product's colour, the copy's headline, the treatment or axis look, and the
 * first platform's own ratio — no decorative element the renderer would not produce.
 */
export function ReviewStep({
  brief,
  onEdit,
}: {
  brief: CampaignBrief;
  onEdit: (section: SectionId) => void;
}): ReactNode {
  const hasProduct = brief.products.length > 0;
  const product = brief.products[0];
  const treatment = brief.treatments?.[0];
  const axes = brief.variation?.axes;
  const wantsMotion = brief.output?.formats?.includes("motion") ?? false;
  const platformId = firstOf(brief.output?.platforms);
  // Derived once, here (§6 question 4) — and handed to the row generation, so
  // the template row's derived px (D55) and the figure cannot disagree.
  const ratio = derivePreviewRatio(platformId, undefined);
  const rows = summaryRows(brief, ratio);
  const layout: LayoutOption | undefined =
    treatment !== undefined ? treatment.layout : (firstOf(axes?.layout) as LayoutOption | undefined);
  const tone: ToneOption | undefined =
    treatment !== undefined ? treatment.tone : (firstOf(axes?.tone) as ToneOption | undefined);
  // The anchor axis (T4) is a variation-axis value only — classic treatments do not carry one.
  const anchor: AnchorOption | undefined =
    treatment !== undefined ? undefined : (firstOf(axes?.anchor) as AnchorOption | undefined);
  const motion: MotionKind | undefined =
    wantsMotion && axes?.motion !== undefined ? (axes.motion[0] as MotionKind) : undefined;
  // D52: a non-procedural background axis names the frame's background a stand-in —
  // the caption says so, in words, never a raw axis id.
  const caption = messages.previewCaption(
    ratioDisplayName(ratio),
    platformId !== undefined ? platformDisplayName(platformId) : messages.previewNoPlatform,
  );
  const figcaptionText = briefBackgroundIsStandIn(brief)
    ? `${caption} · ${messages.previewFrameStandInBackground}`
    : caption;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:items-start">
      <dl className="min-w-0 divide-y divide-border">
        {rows.map((row) => (
          <div
            key={row.section}
            data-review-row={row.section}
            className="flex items-start justify-between gap-4 py-3"
          >
            <div className="min-w-0 space-y-1">
              <dt className="text-[11px] uppercase tracking-widest text-text-muted">
                {SECTION_TITLES[row.section]}
              </dt>
              {row.lines.map((line, index) => (
                // Index, not line text: a fixed positional list, never reordered, and line text can repeat.
                <dd key={index} className="truncate text-[13px] text-text-primary">
                  {line}
                </dd>
              ))}
            </div>
            <button
              type="button"
              aria-label={messages.reviewEditLabel(SECTION_TITLES[row.section])}
              onClick={() => onEdit(row.section)}
              className="shrink-0 rounded-md px-2 py-1 text-[12px] font-semibold text-brand-primary transition-colors hover:bg-surface-2"
            >
              {messages.reviewEdit}
            </button>
          </div>
        ))}
      </dl>
      {hasProduct ? (
        <figure className="flex flex-col gap-2">
          {/* The shared picture (§6 question 4): `ratio` was derived once above, so
              the figure and the dock cannot disagree by deriving twice (C1's trap).
              T1b: the frame is the REAL composited creative, the SVG until it arrives. */}
          <PreviewFrame
            brief={brief}
            layout={layout}
            tone={tone}
            anchor={anchor}
            style={brief.style}
            primaryColor={product.primaryColor}
            headline={brief.campaignMessage}
            motion={motion}
            ratio={ratio}
            className="block h-auto w-full"
          />
          <figcaption className="font-mono text-[11px] text-text-muted">{figcaptionText}</figcaption>
        </figure>
      ) : null}
    </div>
  );
}
