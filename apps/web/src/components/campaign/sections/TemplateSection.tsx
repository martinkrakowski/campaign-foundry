"use client";

import { htmlWeightReading } from "@/components/campaign/derive";
import * as messages from "@/components/campaign/messages";
import { HtmlElementsEditor } from "./HtmlElementsEditor";
import { SectionShell, type SectionProps } from "./IdentitySection";

/**
 * The Template step (L5, L8 — D124, D128), after CC3.
 *
 * **The layer stack is no longer here.** It is `LayerStack`, in the creative
 * rail, and there is exactly one of it
 * (`2026-09-16_creative-first-chrome.md`, lane CC3 and §4.6): the plan fixed
 * the disposition — *"`TemplateSection` stops rendering the stack and the rail
 * becomes the only one"* — because two copies of the same ordered list are two
 * places for the same offer to drift. This step therefore says where the
 * controls went (`templateStackInRail`) rather than going quiet, which is the
 * other half of that decision: a step that renders nothing looks like a
 * failure, and a missing surface presented as an empty one is a fault this
 * repository keeps producing.
 *
 * **What stays: the html layer's element editor.** `HtmlElementsEditor`
 * (HL5a, HL-D1) is an INSPECTOR, not part of the navigator — elements are not
 * layers, so it rode beneath the one layer that carries them rather than in a
 * section of its own. Its proper home is CC4's non-modal sheet (D143), which is
 * gated on this lane and is the third mount site `premise CC4` counts. Until
 * that sheet exists it stays on this step, at full width, where it is usable:
 * moving it into a 16 rem rail column first would degrade a shipped surface for
 * one lane's duration and buy nothing. The iteration is a FILTER over the
 * layers and not the stack — no z-order, no add, no remove, no reorder, no
 * toggle — so `premise CC3` flips on the fact it probes rather than on a
 * rewording.
 */
export function TemplateSection({ state, dispatch }: SectionProps) {
  // The live weight reading (HL5c, HL-D6), computed once for the section: it
  // weighs the whole draft's html markup against the tightest selected html
  // placement, so every html layer's editor shows the same figure. Undefined
  // when no html placement is selected — then no meter renders at all.
  const reading = htmlWeightReading(state);
  const htmlLayers = state.template.layers.filter((layer) => layer.kind === "html");

  return (
    <SectionShell id="template" title="Template">
      <p className="text-[12px] text-text-muted">{messages.templateStackInRail}</p>
      {htmlLayers.map((layer) => (
        <div key={layer.id} className="space-y-2">
          {/* The editor no longer rides inside its layer's stack row, so it
              carries the layer's own id: a template may hold more than one
              html layer, and "Elements" alone would not say whose. */}
          <p className="text-[13px] text-text-primary">
            {messages.templateHtmlLayerLabel(layer.id)}
          </p>
          <HtmlElementsEditor
            layerId={layer.id}
            elements={layer.elements ?? []}
            dispatch={dispatch}
            reading={reading}
          />
        </div>
      ))}
    </SectionShell>
  );
}
