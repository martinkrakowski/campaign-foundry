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
import { PreviewHitRegions } from "./PreviewHitRegions";
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
  selectedLayerId,
  onSelectLayer,
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
  /**
   * CE1 — the picked layer (D139), read only. Ephemeral state owned by the
   * editor: this never stores it and never persists it.
   */
  readonly selectedLayerId?: string | null;
  /**
   * CE1 — the editor's own `pickLayer`. Absent means no hit regions at all, so
   * every surface that mounts a frame without one (the Review figure, the
   * component's own suites) is unchanged. Must be referentially stable: the
   * dock above is `memo`-wrapped.
   */
  readonly onSelectLayer?: (id: string) => void;
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
        /* `relative`, and nothing else new: CE1's hit regions are absolutely
           positioned against THIS box, which is the `<img>`'s box exactly —
           the border adds no padding and the image is `block h-auto w-full`,
           so a percentage of this element is a fraction of the canvas. No
           second `preview-frame` marker is introduced: D43's mount count is
           over this one. */
        className="relative overflow-hidden rounded-lg border border-border bg-text-muted"
      >
        {/* The frame IS the creative — decorative to the reader, named by the caption. */}
        <img src={frame.dataUrl} alt="" className={className} />
        {/* CE1 — the regions ride the REAL frame only. The SVG placeholder
            paints no html elements at all (`CreativePreview`'s layer map has no
            `html` entry), so a region over it would point at nothing drawn.
            A caller with no `onSelectLayer` — the Review figure, every surface
            that is not the editor's rail — gets no regions at all; a withheld
            brief is the regions' own empty case, decided in one place. */}
        {onSelectLayer !== undefined ? (
          <PreviewHitRegions
            brief={brief}
            selectedLayerId={selectedLayerId}
            onSelectLayer={onSelectLayer}
          />
        ) : null}
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
