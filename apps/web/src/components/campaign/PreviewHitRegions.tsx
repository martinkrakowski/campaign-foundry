"use client";

import { Fragment, useId, type CSSProperties, type ReactNode } from "react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import type { BriefTemplate } from "@campaignfoundry/CampaignOrchestration/brief-template";
import type { Frame, HtmlElement } from "@campaignfoundry/CampaignOrchestration/html-element";
import type { LayerKind } from "@campaignfoundry/CampaignOrchestration/layer-kinds";
import { cn } from "@/lib/cn";
import { layerKindDisplayName } from "./display-names";
import * as messages from "./messages";

/**
 * CE1 — reaching a layer from the creative itself rather than from the list
 * below it.
 *
 * **The hit target is an element's DECLARED frame, never its glyph bounds.**
 * `drawHtml` sizes every element box from `frame.x/y/w/h` multiplied by the
 * resolved canvas and nothing else; the `frame.anchor` a text element carries
 * is consumed by `htmlTextFirstLineOffset` alone, which moves the FIRST
 * BASELINE inside a box this component never has to know the height of. So a
 * short label in a wide box means clicking the empty half of that box still
 * picks the layer — correct behaviour for a selection, and the reason nothing
 * here measures text. D52 deleted an SVG twin for trying: the browser and the
 * compositor are two unrelated layout engines that disagree by 0.85x-2.15x with
 * the sign flipping by ratio, so a client-side re-layout of the headline would
 * put the hit region somewhere the raster never drew it.
 *
 * Nothing about the compositor's placement is re-implemented or copied here.
 * The only arithmetic below is `fraction x 100` — the frame's own numbers
 * restated as CSS percentages of the box the `<img>` fills. That works because
 * the frame image does not letterbox (`PreviewDock` hands it
 * `block h-auto w-full`, so the element box IS the content box), which makes
 * the mapping independent of the rendered width: there is no size to read, so
 * there is no size to get wrong at a second one.
 *
 * Real `<button>`s, not one surface doing coordinate maths on a bare click, so
 * keyboard, focus ring and screen-reader naming come for free — the layer list
 * (CC3) remains the primary accessible path and this is an additional
 * affordance, never a replacement. The kit's naming contract (D18, as
 * `LayerStack` pins it): the accessible name is the raw layer id, and the
 * display words ride the description.
 *
 * Selection is D139 ephemeral state owned by the host: this component reads a
 * picked id and reports a click, and stores nothing.
 */

/** One clickable region: an html element's declared frame, and the layer it belongs to. */
export interface PreviewHitRegion {
  /** The layer the click selects — an element is not separately selectable (CC3 lists layers). */
  readonly layerId: string;
  /** The owning layer's kind, for the description's display words. */
  readonly layerKind: LayerKind;
  /** Position in the layer's element list, so two regions of one layer have distinct ids. */
  readonly elementIndex: number;
  /** The element itself; only its `frame` and `kind` are read. */
  readonly element: HtmlElement;
}

/**
 * The regions a template declares, in z-order (array position IS z-order,
 * D128), so a later region paints over an earlier one exactly as the
 * compositor draws it.
 *
 * Only an `html` layer carries elements (HL-D1), and only a layer the
 * compositor actually draws may be hit: an explicit `enabled: false` renders
 * exactly what the same template without that layer renders (X9), so a
 * disabled layer has nothing on the canvas to click. Everything else is
 * excluded for one reason — it declares no frame. A text layer's block is
 * placed by `anchorFirstY` over a MEASURED span and type size, and the logo's
 * corner is snapped against that measured block, so neither has a declared
 * position this side of the compositor; `image`, `video`, `shade` and `accent`
 * resolve from `CREATIVE_GEOMETRY`, but restating their arithmetic here would
 * be the second implementation D52 deleted. The layer list reaches all of them.
 */
export function previewHitRegions(template: BriefTemplate): readonly PreviewHitRegion[] {
  return template.layers
    .filter((layer) => layer.kind === "html" && layer.enabled !== false)
    .flatMap((layer) =>
      (layer.elements ?? []).map((element, elementIndex) => ({
        layerId: layer.id,
        layerKind: layer.kind,
        elementIndex,
        element,
      })),
    );
}

/**
 * A frame as CSS percentages of the image box — the whole of the mapping.
 *
 * Percentages, not pixels: the frame's fractions and the box's percentages are
 * the same units, so the region resolves against whatever width the rail
 * happens to have without anything reading that width. A pixel form would need
 * the rendered size, and would be wrong at every size but the one it was
 * computed at.
 */
export function hitRegionStyle(frame: Frame): CSSProperties {
  return {
    left: `${frame.x * 100}%`,
    top: `${frame.y * 100}%`,
    width: `${frame.w * 100}%`,
    height: `${frame.h * 100}%`,
  };
}

export interface PreviewHitRegionsProps {
  /**
   * The brief the displayed frame was composited from — the regions read its
   * `template` and nothing else, so what is clickable and what was rastered
   * come from one object rather than two that could name different layers.
   *
   * Absent is a real state, not a defensive guard: `PreviewFrame` withholds the
   * brief while the rail is below the breakpoint (CC2) and clears to the
   * placeholder on an identity switch, and a withheld brief declares no frames.
   */
  readonly brief?: CampaignBrief;
  /** The picked layer's id, or null/absent (D139) — ephemeral, owned by the editor. */
  readonly selectedLayerId?: string | null;
  /** The editor's own `pickLayer`: the SAME callback the layer list's rows call. */
  readonly onSelectLayer: (id: string) => void;
}

/**
 * The regions themselves, absolutely positioned inside the frame's own box.
 *
 * A brief that declares no frames renders nothing at all rather than an empty
 * overlay — there is no invisible surface over the creative when there is
 * nothing to click.
 */
export function PreviewHitRegions({
  brief,
  selectedLayerId,
  onSelectLayer,
}: PreviewHitRegionsProps): ReactNode {
  // Per-instance ids: nothing may assume this is mounted once per document —
  // the same rule `LayerStack` states for its own descriptions.
  const uid = useId();
  const regions = brief === undefined ? [] : previewHitRegions(brief.template);
  if (regions.length === 0) return null;
  return (
    <>
      {regions.map((region) => {
        const descId = `${uid}-region-${region.layerId}-${region.elementIndex}`;
        const selected = region.layerId === selectedLayerId;
        return (
          <Fragment key={descId}>
            <span id={descId} className="sr-only">
              {messages.previewRegionDescription(
                layerKindDisplayName(region.layerKind),
                messages.htmlElementKindLabel(region.element.kind),
              )}
            </span>
            <button
              type="button"
              aria-label={region.layerId}
              aria-pressed={selected}
              aria-describedby={descId}
              onClick={() => onSelectLayer(region.layerId)}
              style={hitRegionStyle(region.element.frame)}
              className={cn(
                "absolute rounded-[2px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary",
                selected ? "ring-2 ring-brand-primary" : "ring-0",
              )}
            />
          </Fragment>
        );
      })}
    </>
  );
}
