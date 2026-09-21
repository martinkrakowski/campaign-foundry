"use client";

import { Fragment, useId, type CSSProperties, type ReactNode } from "react";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import type { BriefTemplate } from "@campaignfoundry/CampaignOrchestration/brief-template";
import type { CanvasRect } from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import {
  FULL_CANVAS_RECT,
  isGroundLayerKind,
} from "@campaignfoundry/CampaignOrchestration/creative-geometry";
import type { HtmlElement } from "@campaignfoundry/CampaignOrchestration/html-element";
import type { LayerKind } from "@campaignfoundry/CampaignOrchestration/layer-kinds";
import { cn } from "@/lib/cn";
import { layerKindDisplayName } from "./display-names";
import * as messages from "./messages";

/**
 * CE1/CE2 — reaching a layer from the creative itself rather than from the list
 * below it.
 *
 * CE1 built this out of an element's declared `frame`, which is the right
 * geometry and reached almost nothing: only an `html` layer may carry elements
 * (HL-D1), and the default campaign type resolves to canonical `image-text`,
 * which has no `html` layer at all. A new campaign therefore rendered ZERO
 * regions — the operator clicked the creative and nothing happened. CE2 adds
 * the extension CE1 named itself: a whole-canvas region for the GROUND kinds,
 * whose drawer paints `(0, 0, width, height)` and whose box is therefore the
 * canvas by the compositor's own call rather than by anyone's estimate. What
 * the other frameless kinds get, and why they get nothing, is stated on
 * {@link previewHitRegions}.
 *
 * **The hit target is a DECLARED region, never glyph bounds.**
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
 *
 * One window worth naming, so it is not filed later as hit-region drift: the
 * regions read the LIVE template while the `<img>` holds the last FETCHED
 * frame, so for the `PREVIEW_FRAME_DEBOUNCE_MS` after an operator moves an
 * element's frame, the region has moved and the raster has not. It closes
 * itself when the next frame lands, and it is the same 300 ms the caption and
 * the layer list already live with; the alternative — regions lagging the
 * document — would make a just-edited frame unclickable where it now is.
 */

/**
 * One clickable region: a rect over the frame, and the layer it selects.
 *
 * Two shapes, one type. An ELEMENT region carries the element whose declared
 * `frame` it is (CE1) and its position in the layer's list. A WHOLE-LAYER
 * region (CE2) is the layer itself: no element, and a rect that is the canvas.
 * `element === undefined` tells them apart, and is what the description reads.
 */
export interface PreviewHitRegion {
  /** The layer the click selects — an element is not separately selectable (CC3 lists layers). */
  readonly layerId: string;
  /** The owning layer's kind, for the description's display words. */
  readonly layerKind: LayerKind;
  /** Position in the layer's element list, so two regions of one layer have distinct ids. */
  readonly elementIndex?: number;
  /** The element itself; only its `frame` and `kind` are read. Absent on a whole-layer region. */
  readonly element?: HtmlElement;
  /** The box, in canvas fractions: an element's declared frame, or the canvas. */
  readonly rect: CanvasRect;
}

/**
 * The regions a template declares, in z-order (array position IS z-order,
 * D128), so a later region paints over an earlier one exactly as the
 * compositor draws it — and, because these are ordinary positioned siblings
 * with no `z-index` anywhere, the topmost region at a point is the one that
 * takes the click. That is the whole of the overlap rule: a full-canvas ground
 * region sits UNDER the element regions of the layers above it, exactly as the
 * ground itself sits under their pixels, so clicking an element picks the
 * element's layer and clicking anywhere else picks the ground.
 *
 * Only a layer the compositor actually draws may be hit: an explicit
 * `enabled: false` renders exactly what the same template without that layer
 * renders (X9), so a disabled layer has nothing on the canvas to click. That
 * filter is taken once, for every kind at once.
 *
 * **What gets a region, and why:**
 *
 * - `html` — one per element (HL-D1; only this kind may carry a list), each
 *   the element's own DECLARED `frame`. CE1's rule, unchanged.
 * - `image` and `video` — one per layer, the whole canvas. They are the GROUND
 *   kinds (`GROUND_LAYER_KINDS`): both dispatch to `paintBackground`, which
 *   draws at `(0, 0, width, height)`. The rect is the layer's own draw call,
 *   not a guess, and the domain leaf holds both the set and the rect with a
 *   compositor-side test pinning the set against `LAYER_DRAWERS`.
 *
 * **What does not, and why — CE2's decision, layer by layer:**
 *
 * - `static-text` / `animated-text`: the block is placed by `anchorFirstY`
 *   over a MEASURED span and a fitted type size. There is no declared
 *   rectangle, and measuring the text here is exactly what D52 deleted.
 * - `logo`: its width is a fraction of the canvas, but its HEIGHT is
 *   `image.height × scale` — the logo file's own aspect ratio, known only
 *   after the compositor decodes the file — and the corner is then clamped
 *   into the safe insets. Nothing the brief carries says where it lands.
 * - `shade`: its rect IS available and true (`fillRect(0, 0, width, height)`),
 *   and it is excluded anyway. The gradient runs from `rgba(0,0,0,0)` to at
 *   most `0.7`, so the shade owns no pixel: what the operator is pointing at
 *   under it is the ground, tinted. And it sits directly above the ground in
 *   all three canonical stacks, so a full-canvas shade region would take every
 *   click in the creative and leave the picture — the one thing an operator
 *   means to click — unreachable, which is the defect this lane exists to fix.
 * - `accent`: there is no one rectangle to offer. Which edge the band hugs is
 *   the RESOLVED anchor (`request.anchor ?? textProps.anchor ??` the layout),
 *   a property of the render request rather than of the template these regions
 *   read; and the fade's extent is scaled by `accentWipeFraction(motion,
 *   eased)`, so under `accent-wipe` it is a function of the playhead second.
 *   Exporting a band rect from the domain would not fix that, and would still
 *   be a twin unless `paintAccent` consumed it — a change to the byte-pinned
 *   compositor this lane does not make.
 * - `fill`: it HAS pixels now — L11 gave it a drawer, `image-text` accepts it,
 *   and its rect is its own frame, so unlike `accent` there is one rectangle to
 *   offer and unlike `shade` it really does own what it covers. It is still
 *   excluded, for the reason `shade` is: absent a frame a fill is the whole
 *   canvas (`LAYER_KIND_DEFAULT_RECTS.fill`), and a full-canvas region above
 *   the ground would take every click in the creative. Offering it only when it
 *   carries a frame is the shape that works, and it is a change to what this
 *   surface derives rather than a comment — it belongs to the hit-region lane,
 *   not to the one that gave the kind a drawer.
 *
 * Every excluded kind stays reachable from the layer list, which is and
 * remains the primary path (CC3).
 */
export function previewHitRegions(template: BriefTemplate): readonly PreviewHitRegion[] {
  return template.layers
    .filter((layer) => layer.enabled !== false)
    .flatMap((layer): readonly PreviewHitRegion[] => {
      if (layer.kind === "html") {
        return (layer.elements ?? []).map((element, elementIndex) => ({
          layerId: layer.id,
          layerKind: layer.kind,
          elementIndex,
          element,
          rect: element.frame,
        }));
      }
      if (isGroundLayerKind(layer.kind)) {
        return [{ layerId: layer.id, layerKind: layer.kind, rect: FULL_CANVAS_RECT }];
      }
      return [];
    });
}

/**
 * A rect as CSS percentages of the image box — the whole of the mapping.
 *
 * Percentages, not pixels: the rect's fractions and the box's percentages are
 * the same units, so the region resolves against whatever width the rail
 * happens to have without anything reading that width. A pixel form would need
 * the rendered size, and would be wrong at every size but the one it was
 * computed at.
 *
 * The whole-canvas region goes through this same function rather than an
 * `inset-0` branch of its own: `{ x: 0, y: 0, w: 1, h: 1 }` is already
 * `0%/0%/100%/100%` here, and a second code path would be a second place for
 * the mapping to be wrong.
 */
export function hitRegionStyle(frame: CanvasRect): CSSProperties {
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
 * A template that offers no region renders nothing at all rather than an empty
 * overlay — there is no invisible surface over the creative when there is
 * nothing to click.
 *
 * **No `z-index`, deliberately.** These are positioned siblings emitted in the
 * template's own order, and positioned siblings with an auto z-index paint —
 * and so hit-test — in DOM order. That makes the stacking of the regions the
 * stacking of the layers, for free and with nothing to keep in sync. A
 * `z-index` on any one of them (to "lift the selected one", say) would put a
 * region somewhere the layer it names is not, which is why the order and the
 * absence of a z-index are both asserted rather than described.
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
        // `-layer` rather than an index for the whole-layer regions. Not for
        // uniqueness — the layer id above already carries that, and a layer is
        // either an `html` layer with elements or a ground layer with one
        // whole-layer region, never both — but because `String(undefined)`
        // would put the literal text "undefined" in a description id, which is
        // the kind of thing that later reads as a bug in something else.
        const slot = region.element === undefined ? "layer" : String(region.elementIndex);
        const descId = `${uid}-region-${region.layerId}-${slot}`;
        const selected = region.layerId === selectedLayerId;
        return (
          <Fragment key={descId}>
            <span id={descId} className="sr-only">
              {region.element === undefined
                ? messages.previewWholeLayerRegionDescription(
                    layerKindDisplayName(region.layerKind),
                  )
                : messages.previewRegionDescription(
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
              style={hitRegionStyle(region.rect)}
              className={cn(
                // `ring-inset`, or the ground region has no visible state at
                // all. A ring is a box-shadow drawn OUTSIDE the border box, and
                // a whole-canvas region fills its container exactly — a
                // container `PreviewFrame` gives `overflow-hidden` — so an
                // outset ring lands entirely in the clipped zone: no focus
                // indicator for a keyboard user, and no highlight when the
                // layer list picks the picture. Inset draws it inside the
                // region, which is also right for an element frame flush to an
                // edge. Neither happy-dom nor any assertion here performs
                // layout, so this is pinned as a class rather than as a pixel.
                "absolute rounded-[2px] ring-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary",
                selected ? "ring-2 ring-brand-primary" : "ring-0",
              )}
            />
          </Fragment>
        );
      })}
    </>
  );
}
