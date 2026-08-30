export { IdentitySection, SectionShell, Field, countErrors } from "./IdentitySection";
export type { SectionProps } from "./IdentitySection";
export { CopySection } from "./CopySection";
export { ProductsSection } from "./ProductsSection";
export { TreatmentsSection } from "./TreatmentsSection";
export { OutputSection } from "./OutputSection";
export { PolicySection } from "./PolicySection";

/**
 * The display name for each section, keyed by its id. This is the one vocabulary the
 * Sections outline reads (GB-D18) — a row, an ErrorStrip chip and a section heading all
 * name the same thing from here rather than each spelling its own list.
 */
/** The section ids, as a closed set — so a lookup keyed by one is total (no fallback). */
export type SectionId = "identity" | "copy" | "products" | "treatments" | "output" | "policy";

export const SECTION_TITLES: Record<SectionId, string> = {
  identity: "Identity",
  copy: "Copy",
  products: "Products",
  treatments: "Treatments",
  output: "Output",
  policy: "Variation Policy",
};

/** Section order by mode (D17). */
export function sectionOrder(mode: "brief" | "variation"): SectionId[] {
  if (mode === "variation") {
    return ["identity", "copy", "products", "output", "policy"];
  }
  return ["identity", "copy", "products", "treatments", "output"];
}
