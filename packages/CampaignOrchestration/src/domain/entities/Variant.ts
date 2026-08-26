import type { AspectRatioValue } from "../value-objects/AspectRatio.vo.js";
import type { LayoutKind, ToneKind } from "../value-objects/Treatment.vo.js";
import type { BackgroundAxisSource } from "../value-objects/VariationPolicy.vo.js";

/**
 * Variant — one planned creative in a {@link VariationPlan}.
 *
 * Identity in variation mode is `productId` + `index`. `seed` is provenance.
 * `treatment` is not stored: use {@link variantTreatmentId}.
 */
export interface Variant {
  readonly index: number;
  readonly seed: number;
  readonly productId: string;
  readonly aspectRatio: AspectRatioValue;
  readonly layout: LayoutKind;
  readonly tone: ToneKind;
  readonly backgroundSource: BackgroundAxisSource;
  readonly paletteShift: number;
}

/** Synthesized treatment label for display / classic-shaped paths. */
export function variantTreatmentId(variant: Variant): string {
  return `${variant.layout}-${variant.tone}`;
}
