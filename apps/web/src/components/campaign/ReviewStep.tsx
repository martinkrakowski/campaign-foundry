import type { ReactNode } from "react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import type { MotionKind } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import { CreativePreview, type LayoutOption, type ToneOption } from "./CreativePreview";
import { derivePreviewRatio } from "./PreviewDock";
import { formatDisplayName, platformDisplayName, ratioDisplayName } from "./display-names";
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
function summaryRows(brief: CampaignBrief): SummaryRow[] {
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
        if (brief.treatments !== undefined) {
          rows.push({
            section,
            lines: [messages.joinList(brief.treatments.map((treatment) => treatment.id))],
          });
        }
        break;
      case "output": {
        const formats = brief.output?.formats;
        const platforms = brief.output?.platforms;
        if (formats !== undefined && platforms !== undefined) {
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
  const rows = summaryRows(brief);
  const hasProduct = brief.products.length > 0;
  const product = brief.products[0];
  const treatment = brief.treatments?.[0];
  const axes = brief.variation?.axes;
  const wantsMotion = brief.output?.formats?.includes("motion") ?? false;
  const platformId = firstOf(brief.output?.platforms);
  const ratio = derivePreviewRatio(platformId, undefined);
  const layout: LayoutOption | undefined =
    treatment !== undefined ? treatment.layout : (firstOf(axes?.layout) as LayoutOption | undefined);
  const tone: ToneOption | undefined =
    treatment !== undefined ? treatment.tone : (firstOf(axes?.tone) as ToneOption | undefined);
  const motion: MotionKind | undefined =
    wantsMotion && axes?.motion !== undefined ? (axes.motion[0] as MotionKind) : undefined;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
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
              {row.lines.map((line) => (
                <dd key={line} className="truncate text-[13px] text-text-primary">
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
          <div className="overflow-hidden rounded-lg border border-border bg-text-muted">
            <CreativePreview
              layout={layout}
              tone={tone}
              primaryColor={product.primaryColor}
              headline={brief.campaignMessage}
              motion={motion}
              ratio={ratio}
              className="block h-auto w-full"
            />
          </div>
          <figcaption className="font-mono text-[11px] text-text-muted">
            {messages.previewCaption(
              ratioDisplayName(ratio),
              platformId !== undefined ? platformDisplayName(platformId) : messages.previewNoPlatform,
            )}
          </figcaption>
        </figure>
      ) : null}
    </div>
  );
}
