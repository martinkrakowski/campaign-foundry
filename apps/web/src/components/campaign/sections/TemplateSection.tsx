"use client";

import * as messages from "@/components/campaign/messages";
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
 * It does render the template's own structural error (D165,
 * `validateTemplate`): the error strip jumps here, so the step is where the
 * message has to be, naming the layer to fix in the rail.
 */
export function TemplateSection({ errors }: SectionProps) {
  return (
    <SectionShell id="template" title="Template">
      <p className="text-[12px] text-text-muted">{messages.templateStackInRail}</p>
      {errors.layerLink ? (
        <p role="alert" data-field-key="layerLink" className="text-[11px] text-error">
          {errors.layerLink}
        </p>
      ) : null}
    </SectionShell>
  );
}
