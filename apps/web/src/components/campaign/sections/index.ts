export { IdentitySection, SectionShell, Field, countErrors } from "./IdentitySection";
export type { SectionProps } from "./IdentitySection";
export { CopySection } from "./CopySection";
export { ProductsSection } from "./ProductsSection";
export { TreatmentsSection } from "./TreatmentsSection";
export { OutputSection } from "./OutputSection";
export { PolicySection } from "./PolicySection";

export { LayoutSection } from "./LayoutSection";
export { TemplateSection } from "./TemplateSection";

/**
 * The display name for each section, keyed by its id. This is the one vocabulary the
 * Sections outline reads (GB-D18) — a row, an ErrorStrip chip and a section heading all
 * name the same thing from here rather than each spelling its own list.
 */
/** The section ids, as a closed set — so a lookup keyed by one is total (no fallback). */
export type SectionId = "identity" | "copy" | "products" | "treatments" | "output" | "policy" | "layout" | "template";

export const SECTION_TITLES: Record<SectionId, string> = {
  identity: "Identity",
  copy: "Copy",
  products: "Products",
  treatments: "Treatments",
  output: "Output",
  policy: "Variation Policy",
  layout: "Layout",
  template: "Template",
};

/**
 * Section order by mode (D17).
 *
 * The Template step (L5 — D124) is the campaign's layer list: what every
 * creative is made of, bottom first, with the add and remove offers the
 * compatibility table permits. It immediately precedes the Layout step
 * (T7 — D62/D63), the template's home — the brief-level type every creative
 * inherits, hosted with the real-ratio preview — whose type the layers carry,
 * and Layout still immediately precedes Output in BOTH modes: the template is
 * the last word on what the creatives look like, and Output and Policy are the
 * delivery and planning steps that consume it.
 */
export function sectionOrder(mode: "brief" | "variation"): SectionId[] {
  if (mode === "variation") {
    return ["identity", "copy", "products", "template", "layout", "output", "policy"];
  }
  return ["identity", "copy", "products", "treatments", "template", "layout", "output"];
}
