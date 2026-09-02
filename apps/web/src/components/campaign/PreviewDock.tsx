import type { CSSProperties, ReactNode } from "react";
import type { AspectRatioValue } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import type { MotionKind } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import { PLATFORM_PROFILES } from "@campaignfoundry/Distribution/platform-profiles";
import { CreativePreview, type CreativePreviewProps } from "@/components/campaign/CreativePreview";
import { Eyebrow } from "@/components/ui";
import { MOTION_KIND_META } from "@/components/campaign/MotionKindPanel";
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
  /** The wizard's current step, 1-based (`stepIndex + 1`) — where the walk stands, never a position in the creative set (M2). */
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

/** `<ratio display name> · <platform label>`, joined by the video style's own name in words when the creative moves (D50) — display labels, never raw kind ids (D18). */
function PreviewCaption({
  platformId,
  ratio,
  motion,
}: {
  platformId?: string;
  ratio: AspectRatioValue;
  motion?: MotionKind;
}): ReactNode {
  const platformLabel =
    platformId !== undefined ? platformDisplayName(platformId) : messages.previewNoPlatform;
  return (
    <p className="truncate font-mono text-[11px] text-text-muted">
      {motion !== undefined
        ? messages.previewCaptionMotion(ratioDisplayName(ratio), platformLabel, MOTION_KIND_META[motion])
        : messages.previewCaption(ratioDisplayName(ratio), platformLabel)}
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

/**
 * The picture at its true ratio, bounded by the box handed to it. The one rule
 * (§6 question 4): `ratio` is FINAL — the caller derives it with
 * `derivePreviewRatio` at the call site and this never derives again, so the
 * dock and the Review figure cannot disagree by deriving twice. Shared by both
 * surfaces for exactly that reason.
 */
export function PreviewPicture(props: {
  readonly layout?: PreviewShowcaseProps["layout"];
  readonly tone?: PreviewShowcaseProps["tone"];
  readonly primaryColor: string;
  readonly headline?: string;
  readonly motion?: MotionKind;
  readonly ratio: AspectRatioValue;
  readonly className: string;
}): ReactNode {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-text-muted">
      <CreativePreview
        layout={props.layout}
        tone={props.tone}
        primaryColor={props.primaryColor}
        headline={props.headline}
        motion={props.motion}
        ratio={props.ratio}
        className={props.className}
      />
    </div>
  );
}

/**
 * The preview itself (D26): the creative at its own ratio, the caption under it,
 * and the brief's name, headline and step beside it — the outgoing creative stays
 * in the corner of the eye while the brief is edited. Props come from the one
 * exported derivation (`previewDockProps`, D45); the complementary landmark, the
 * sticky positioning and the container-query visibility belong to the host rail
 * that mounts this body (D44/D61) — exactly one slot, whatever view it holds.
 */
export function PreviewDock(props: PreviewShowcaseProps): ReactNode {
  const ratio = derivePreviewRatio(props.platformId, props.ratio);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Eyebrow as="p">{messages.previewLegend}</Eyebrow>
      <PreviewPicture
        layout={props.layout}
        tone={props.tone}
        primaryColor={props.primaryColor}
        headline={props.headline}
        motion={props.motion}
        ratio={ratio}
        className="block h-auto w-full"
      />
      <div className="flex items-center gap-2">
        <PreviewSwatch primaryColor={props.primaryColor} />
        <PreviewCaption platformId={props.platformId} ratio={ratio} motion={props.motion} />
      </div>
      <PreviewIdentity {...props} />
    </div>
  );
}
