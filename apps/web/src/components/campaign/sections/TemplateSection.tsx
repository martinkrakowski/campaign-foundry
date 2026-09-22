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
 */
export function TemplateSection(_props: SectionProps) {
  return (
    <SectionShell id="template" title="Template">
      <p className="text-[12px] text-text-muted">{messages.templateStackInRail}</p>
    </SectionShell>
  );
}
