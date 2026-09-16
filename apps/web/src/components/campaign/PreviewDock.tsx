import { memo, useState, type CSSProperties, type ReactNode, type SyntheticEvent } from "react";
import type { AspectRatioValue, CanvasSpec } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { RATIO_VALUES } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { DISPLAY_SIZE_VALUES } from "@campaignfoundry/CampaignOrchestration/display-sizes";
import type { CampaignBrief, Style } from "@campaignfoundry/CampaignOrchestration";
import { DEFAULT_DURATION_SEC } from "@campaignfoundry/CampaignOrchestration/variation-defaults";
import type { MotionKind } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import { PLATFORM_PROFILES } from "@campaignfoundry/Distribution/platform-profiles";
import { CreativePreview, type CreativePreviewProps } from "@/components/campaign/CreativePreview";
import { PreviewFrame } from "@/components/campaign/PreviewFrame";
import { Eyebrow } from "@/components/ui";
import { MOTION_KIND_META } from "@/components/campaign/MotionKindPanel";
import {
  canvasDisplayName,
  platformDisplayName,
  TEXT_EFFECT_META,
} from "@/components/campaign/display-names";
import { briefBackgroundIsStandIn } from "@/lib/preview-frame";
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
    if (profile?.ratio !== undefined) return profile.ratio;
  }
  if (explicitRatio !== undefined && (RATIO_VALUES as readonly string[]).includes(explicitRatio)) {
    return explicitRatio as AspectRatioValue;
  }
  return "1:1";
}

/**
 * The canvas the preview draws: a display size when the brief asked for one,
 * otherwise the social ratio `derivePreviewRatio` already answers. One
 * derivation, so the dock, the Layout readout and the Review figure cannot
 * disagree by deriving twice.
 */
export function derivePreviewSpec(
  platformId: string | undefined,
  explicitRatio: string | undefined,
  sizes?: readonly string[],
): CanvasSpec {
  const first = sizes?.[0];
  if (first !== undefined) {
    for (const size of DISPLAY_SIZE_VALUES) {
      if (size === first) return { size };
    }
  }
  return { ratio: derivePreviewRatio(platformId, explicitRatio) };
}

export interface PreviewShowcaseProps extends Omit<CreativePreviewProps, "className"> {
  readonly campaignName: string;
  readonly platformId?: string;
  /**
   * The draft's projection (T1b): when present, the dock composites a REAL frame
   * from the preview route and derives the stand-in caption from the brief's
   * background axis (D52). Absent → the SVG placeholder only.
   */
  readonly brief?: CampaignBrief;
  /**
   * Stable identity for a not-yet-saved draft (`source.tempId`). Forwarded to
   * the frame so a re-slug of `brief.id` is not a switch of creative.
   */
  readonly identityKey?: string;
  /**
   * The wizard's current step, 1-based (`stepIndex + 1`) — where the walk
   * stands, never a position in the creative set (M2). Optional: D141 —
   * `everything` (and any future presentation with no step concept) has no
   * cursor to show, and the caller omits both fields rather than passing a
   * stale one.
   */
  readonly step?: number;
  readonly stepCount?: number;
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

/** `<ratio display name> · <platform label>`, joined by each motion style's own name in words when the creative moves or the template carries a text effect (D50/T6) — display labels, never raw kind ids (D18). A non-procedural background axis adds the stand-in suffix (D52). */
function PreviewCaption({
  platformId,
  spec,
  motion,
  textEffect,
  standIn,
}: {
  platformId?: string;
  spec: CanvasSpec;
  motion?: MotionKind;
  textEffect?: Style["textEffect"];
  standIn: boolean;
}): ReactNode {
  const platformLabel =
    platformId !== undefined ? platformDisplayName(platformId) : messages.previewNoPlatform;
  const canvasLabel = canvasDisplayName(spec);
  const styleLabels = [
    motion !== undefined ? MOTION_KIND_META[motion] : undefined,
    textEffect !== undefined ? TEXT_EFFECT_META[textEffect] : undefined,
  ].filter((label): label is string => label !== undefined);
  const caption =
    styleLabels.length > 0
      ? messages.previewCaptionMotion(canvasLabel, platformLabel, styleLabels.join(" · "))
      : messages.previewCaption(canvasLabel, platformLabel);
  return (
    <p className="truncate font-mono text-[11px] text-text-muted">
      {standIn ? `${caption} · ${messages.previewFrameStandInBackground}` : caption}
    </p>
  );
}

export interface PreviewIdentityProps {
  readonly campaignName: string;
  readonly headline?: string;
  readonly step?: number;
  readonly stepCount?: number;
}

/**
 * The brief's own words: campaign name, headline, and the step readout. The
 * step readout is itself optional (D141): `everything` has no step cursor to
 * show (`stepIndex` is stale outside guided), so a caller that omits `step`/
 * `stepCount` gets no readout rather than a guessed or stale one — never
 * `previewStep(undefined, undefined)`.
 */
export function PreviewIdentity(props: PreviewIdentityProps): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="truncate font-semibold text-[13px] text-text-primary">{props.campaignName}</p>
      {props.headline !== undefined && props.headline.length > 0 ? (
        <p className="truncate text-[12px] text-text-muted">{props.headline}</p>
      ) : null}
      {props.step !== undefined && props.stepCount !== undefined ? (
        <p className="font-mono text-[11px] text-text-muted">{messages.previewStep(props.step, props.stepCount)}</p>
      ) : null}
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
  readonly anchor?: PreviewShowcaseProps["anchor"];
  readonly style?: PreviewShowcaseProps["style"];
  readonly primaryColor: string;
  readonly headline?: string;
  readonly motion?: MotionKind;
  readonly spec?: CanvasSpec;
  readonly ratio?: AspectRatioValue;
  readonly className: string;
}): ReactNode {
  return (
    // CC1 — a stable mount marker (D43): counted by tests that must tell
    // "exactly one composed frame is MOUNTED" from "one is visible" — the
    // rail's container query hides without unmounting, and this marker is
    // present in both branches `PreviewFrame` can render (this placeholder,
    // and the real `<img>` frame below).
    <div data-testid="preview-frame" className="overflow-hidden rounded-lg border border-border bg-text-muted">
      <CreativePreview
        layout={props.layout}
        tone={props.tone}
        anchor={props.anchor}
        style={props.style}
        primaryColor={props.primaryColor}
        headline={props.headline}
        motion={props.motion}
        spec={props.spec}
        ratio={props.ratio}
        className={props.className}
      />
    </div>
  );
}

/**
 * D142 — the rail's content before the first product has an id: names the
 * missing field, invents nothing (D26). Shares `PreviewIdentity`'s shape
 * with `PreviewDock` so the two never visually disagree about the campaign
 * name or the walk's cursor when one replaces the other.
 */
export function PreviewRailEmptyState(props: PreviewIdentityProps): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Eyebrow as="p">{messages.previewLegend}</Eyebrow>
      <p className="text-[12px] text-text-muted">{messages.previewNeedsProductId}</p>
      <PreviewIdentity {...props} />
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
 *
 * Wrapped in `memo` (CC2/CC1): the rail widens to every presentation and step
 * (D141), and will host a layer list and a timeline of its own soon (CC3/CC5,
 * C3) — a `useMemo`-value-keyed `brief`/props pair from `BriefEditor` lets
 * this bail on a re-render for a keystroke the look does not change, exactly
 * as it already skips a network fetch for one.
 */
function PreviewDockImpl(props: PreviewShowcaseProps): ReactNode {
  const spec = props.spec ?? derivePreviewSpec(props.platformId, props.ratio, props.brief?.output?.sizes);
  const durationSec = props.brief?.variation?.axes?.duration?.[0] ?? DEFAULT_DURATION_SEC;
  const [scrubSec, setScrubSec] = useState(0);
  const [committedSec, setCommittedSec] = useState(0);
  const hasMotion = props.motion !== undefined;
  const clampedScrubSec = Math.min(Math.max(0, scrubSec), Math.max(0, durationSec));
  const clampedCommittedSec = Math.min(Math.max(0, committedSec), Math.max(0, durationSec));

  const handleCommit = (e: SyntheticEvent<HTMLInputElement>) => {
    setCommittedSec(Number(e.currentTarget.value));
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Eyebrow as="p">{messages.previewLegend}</Eyebrow>
      <PreviewFrame
        brief={props.brief}
        layout={props.layout}
        tone={props.tone}
        anchor={props.anchor}
        style={props.style}
        primaryColor={props.primaryColor}
        headline={props.headline}
        motion={props.motion}
        durationSec={hasMotion ? durationSec : undefined}
        atSec={hasMotion ? clampedCommittedSec : undefined}
        spec={spec}
        identityKey={props.identityKey}
        className="block h-auto w-full"
      />
      {hasMotion ? (
        <div className="flex items-center gap-2 px-1">
          <input
            type="range"
            aria-label={messages.previewScrubLabel}
            min={0}
            max={durationSec}
            step="any"
            value={clampedScrubSec}
            onChange={(e) => {
              const val = Number(e.target.value);
              setScrubSec(val);
            }}
            onPointerUp={handleCommit}
            onKeyUp={handleCommit}
            className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-surface-2 accent-brand-primary"
          />
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <PreviewSwatch primaryColor={props.primaryColor} />
        <PreviewCaption
          platformId={props.platformId}
          spec={spec}
          motion={props.motion}
          textEffect={props.style?.textEffect}
          standIn={props.brief !== undefined && briefBackgroundIsStandIn(props.brief)}
        />
      </div>
      <PreviewIdentity {...props} />
    </div>
  );
}

export const PreviewDock = memo(PreviewDockImpl);
