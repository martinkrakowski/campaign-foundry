import type { CSSProperties, ReactNode } from "react";
import type { AspectRatioValue } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { PLATFORM_PROFILES } from "@campaignfoundry/Distribution/platform-profiles";
import { CreativePreview, type CreativePreviewProps } from "@/components/campaign/CreativePreview";
import { platformDisplayName, ratioDisplayName } from "@/components/campaign/display-names";
import * as messages from "@/components/campaign/messages";

/**
 * The platform's own ratio wins (a story is 9:16 regardless of the shape chips it was
 * assigned from), the explicit ratio next, and a square as the universal default — the
 * ratio the current platform set most often packages at. Never a blend: one preview.
 */
export function derivePreviewRatio(
  platformId: string | undefined,
  explicitRatio: string | undefined,
): AspectRatioValue {
  if (platformId !== undefined) {
    const profile = PLATFORM_PROFILES[platformId];
    if (profile !== undefined) return profile.ratio;
  }
  if (explicitRatio !== undefined && (RATIO_VALUES as readonly string[]).includes(explicitRatio)) {
    return explicitRatio as AspectRatioValue;
  }
  return "1:1";
}

export interface PreviewShowcaseProps extends Omit<CreativePreviewProps, "className"> {
  readonly campaignName: string;
  readonly platformId?: string;
  /** 1-based position in the campaign's creative set. */
  readonly step: number;
  readonly stepCount: number;
}

/** The product colour the preview was drawn in, as a chip. Token rule aside: `--c`. */
function PreviewSwatch({ primaryColor }: { primaryColor: string }): ReactNode {
  return (
    <span
      className="h-3 w-3 shrink-0 rounded-full bg-[var(--c)]"
      style={{ "--c": primaryColor } as CSSProperties}
      aria-hidden="true"
    />
  );
}

/** `<ratio display name> · <platform label>` (D18 — display names, never raw values). */
function PreviewCaption({ platformId, ratio }: { platformId?: string; ratio?: string }): ReactNode {
  return (
    <p className="truncate font-mono text-[11px] text-text-muted">
      {messages.previewCaption(
        ratioDisplayName(derivePreviewRatio(platformId, ratio)),
        platformId !== undefined ? platformDisplayName(platformId) : messages.previewNoPlatform,
      )}
    </p>
  );
}

/** The brief's own words: campaign name, headline, and the step readout. */
function PreviewIdentity(props: PreviewShowcaseProps): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="truncate font-semibold text-[13px] text-text-primary">{props.campaignName}</p>
      {props.headline !== undefined && props.headline.length > 0 ? (
        <p className="truncate text-[12px] text-text-muted">{props.headline}</p>
      ) : null}
      <p className="font-mono text-[11px] text-text-muted">{messages.previewStep(props.step, props.stepCount)}</p>
    </div>
  );
}

/** The picture at its true ratio, bounded by the box handed to it. */
function PreviewPicture(props: Pick<PreviewShowcaseProps, "layout" | "tone" | "primaryColor" | "headline" | "motion" | "ratio" | "platformId"> & { readonly className: string }): ReactNode {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-text-muted">
      <CreativePreview
        layout={props.layout}
        tone={props.tone}
        primaryColor={props.primaryColor}
        headline={props.headline}
        motion={props.motion}
        ratio={derivePreviewRatio(props.platformId, props.ratio)}
        className={props.className}
      />
    </div>
  );
}

/**
 * The desktop rail (≥ 1280 px): the creative at its own ratio, the caption under it,
 * and the brief's name, headline and step beside it — the outgoing creative stays in
 * the corner of the eye while the brief is edited (D26). `hidden xl:flex`/`flex xl:hidden`
 * pair with `PreviewStrip` so exactly one is on screen.
 */
export function PreviewDock(props: PreviewShowcaseProps): ReactNode {
  return (
    <aside className="hidden w-64 shrink-0 flex-col gap-3 border-l border-border bg-surface p-4 xl:flex">
      <p className="font-mono text-[11px] uppercase tracking-widest text-text-muted">{messages.previewLegend}</p>
      <PreviewPicture {...props} className="block h-auto w-full" />
      <div className="flex items-center gap-2">
        <PreviewSwatch primaryColor={props.primaryColor} />
        <PreviewCaption platformId={props.platformId} ratio={props.ratio} />
      </div>
      <PreviewIdentity {...props} />
    </aside>
  );
}

/**
 * The mobile/tablet rail (< 1280 px): the same information as `PreviewDock`, compressed
 * into a horizontal bar across the bottom — picture, campaign name, headline, caption,
 * the swatch and the step.
 */
export function PreviewStrip(props: PreviewShowcaseProps): ReactNode {
  return (
    <div className="flex xl:hidden items-center gap-3 border-t border-border bg-surface px-4 py-3">
      <div className="flex-none">
        <PreviewPicture {...props} className="block h-16 w-auto" />
      </div>
      <PreviewIdentity {...props} />
      <div className="flex shrink-0 items-center gap-2">
        <PreviewSwatch primaryColor={props.primaryColor} />
        <PreviewCaption platformId={props.platformId} ratio={props.ratio} />
        <p className="font-mono text-[11px] text-text-muted">{messages.previewStep(props.step, props.stepCount)}</p>
      </div>
    </div>
  );
}