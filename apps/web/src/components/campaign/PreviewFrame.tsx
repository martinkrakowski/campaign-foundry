"use client";

import { useMemo, type ReactNode } from "react";
import type {
  AspectRatioValue,
  CanvasSpec,
} from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
import { canvasSpecOf } from "@/components/ui/preview-layers";
import type { CampaignBrief, PreviewCellSelection } from "@campaignfoundry/CampaignOrchestration";
import type { MotionKind } from "@campaignfoundry/CampaignOrchestration/motion-kinds";
import type { AnchorOption, LayoutOption, ToneOption } from "./CreativePreview";
import { PreviewPicture } from "./PreviewDock";
import type { CreativePreviewProps } from "./CreativePreview";
import { usePreviewFrame } from "@/lib/preview-frame";

/**
 * The real-frame picture (D52): the same box `PreviewPicture` draws, holding the
 * REAL composited frame at the real ratio once it arrives. Until then — on mount,
 * on every edit while a frame is in flight, and on error — the SVG placeholder
 * shows, synchronously: never a broken-image state, never an empty box.
 *
 * The frame is fetched only when the look is fully specified (a product with a
 * non-empty id, a layout and a tone); an unspecified look — including the blank
 * draft's placeholder product (id "") — has nothing to render a frame of, so the
 * placeholder stands and the hook idles. The SVG remains the fabrication-test surface.
 */
export function PreviewFrame({
  brief,
  layout,
  tone,
  anchor,
  style,
  primaryColor,
  headline,
  motion,
  durationSec,
  atSec,
  spec,
  ratio,
  identityKey,
  className,
}: {
  readonly brief?: CampaignBrief;
  readonly layout?: LayoutOption;
  readonly tone?: ToneOption;
  readonly anchor?: AnchorOption;
  readonly style?: CreativePreviewProps["style"];
  readonly primaryColor: string;
  readonly headline?: string;
  readonly motion?: MotionKind;
  readonly durationSec?: number;
  readonly atSec?: number;
  readonly spec?: CanvasSpec;
  /**
   * @deprecated Prefer `spec`. Social-ratio shorthand kept so existing
   * `{ ratio }` call sites type-check.
   */
  readonly ratio?: AspectRatioValue;
  /**
   * Stable identity for a not-yet-saved draft. Forwarded to `usePreviewFrame`
   * so a re-slug of `brief.id` does not clear the painted frame.
   */
  readonly identityKey?: string;
  readonly className: string;
}): ReactNode {
  const canvas = canvasSpecOf(spec, ratio);
  // The cell carries the whole CanvasSpec — a social ratio or a display size —
  // so a leaderboard preview requests the real frame too, not only the social
  // family. The memo keys on the spec's own family value.
  const cell = useMemo<PreviewCellSelection | undefined>(() => {
    const product = brief?.products[0];
    if (
      product === undefined ||
      product.id.length === 0 ||
      layout === undefined ||
      tone === undefined
    ) {
      return undefined;
    }
    const hasMotion = motion !== undefined && durationSec !== undefined && atSec !== undefined;
    return {
      productId: product.id,
      canvas,
      layout,
      tone,
      ...(anchor !== undefined ? { anchor } : {}),
      ...(hasMotion ? { motion, durationSec, atSec } : {}),
    };
  }, [brief, layout, tone, anchor, canvas, motion, durationSec, atSec]);
  const { frame } = usePreviewFrame(brief, cell, identityKey);

  if (frame !== null) {
    return (
      <div
        data-testid="preview-frame"
        className="overflow-hidden rounded-lg border border-border bg-text-muted"
      >
        {/* The frame IS the creative — decorative to the reader, named by the caption. */}
        <img src={frame.dataUrl} alt="" className={className} />
      </div>
    );
  }
  return (
    <PreviewPicture
      layout={layout}
      tone={tone}
      anchor={anchor}
      style={style}
      primaryColor={primaryColor}
      headline={headline}
      motion={motion}
      spec={canvas}
      className={className}
    />
  );
}
