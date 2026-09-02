export { IdentitySection, SectionShell, Field, countErrors } from "./IdentitySection";
export type { SectionProps } from "./IdentitySection";
export { CopySection } from "./CopySection";
export { ProductsSection } from "./ProductsSection";
export { TreatmentsSection } from "./TreatmentsSection";
export { OutputSection } from "./OutputSection";
export { PolicySection } from "./PolicySection";

export { LayoutSection } from "./LayoutSection";

/**
 * The display name for each section, keyed by its id. This is the one vocabulary the
 * Sections outline reads (GB-D18) — a row, an ErrorStrip chip and a section heading all
 * name the same thing from here rather than each spelling its own list.
 */
/** The section ids, as a closed set — so a lookup keyed by one is total (no fallback). */
export type SectionId = "identity" | "copy" | "products" | "treatments" | "output" | "policy" | "layout";

export const SECTION_TITLES: Record<SectionId, string> = {
  identity: "Identity",
  copy: "Copy",
  products: "Products",
  treatments: "Treatments",
  output: "Output",
  policy: "Variation Policy",
  layout: "Layout",
};

/**
 * Section order by mode (D17).
 *
 * The Layout step (T7 — D62/D63) is the template's home: the brief-level type every
 * creative inherits, hosted with the real-ratio preview. It follows the content and
 * the look steps — identity, copy, products, and the per-look choices (Treatments in
 * Classic; the lock-or-vary cards stay on Variation Policy in Randomized) — and
 * immediately precedes Output in BOTH modes: the template is the last word on what
 * the creatives look like, and Output and Policy are the delivery and planning steps
 * that consume it.
 */
export function sectionOrder(mode: "brief" | "variation"): SectionId[] {
  if (mode === "variation") {
    return ["identity", "copy", "products", "layout", "output", "policy"];
  }
  return ["identity", "copy", "products", "treatments", "layout", "output"];
}
