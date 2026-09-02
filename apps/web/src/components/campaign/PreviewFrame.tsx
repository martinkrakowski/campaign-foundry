"use client";

import { useMemo, type ReactNode } from "react";
import type { AspectRatioValue } from "@campaignfoundry/CampaignOrchestration/aspect-ratios";
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
 * The frame is fetched only when the look is fully specified (a product, a layout
 * and a tone); an unspecified look has nothing to render a frame of, so the
 * placeholder stands. The SVG remains the fabrication-test surface.
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
  ratio,
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
  readonly ratio: AspectRatioValue;
  readonly className: string;
}): ReactNode {
  const cell = useMemo<PreviewCellSelection | undefined>(() => {
    const product = brief?.products[0];
    if (product === undefined || layout === undefined || tone === undefined) return undefined;
    return {
      productId: product.id,
      ratio,
      layout,
      tone,
      ...(anchor !== undefined ? { anchor } : {}),
    };
  }, [brief, layout, tone, anchor, ratio]);
  const { frame } = usePreviewFrame(brief, cell);

  if (frame !== null) {
    return (
      <div className="overflow-hidden rounded-lg border border-border bg-text-muted">
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
      ratio={ratio}
      className={className}
    />
  );
}
