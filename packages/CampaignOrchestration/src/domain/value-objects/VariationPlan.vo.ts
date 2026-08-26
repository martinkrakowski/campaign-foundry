import type { Variant } from "../entities/Variant.js";
import type { VariationPolicy } from "./VariationPolicy.vo.js";

export interface VariationEstimate {
  readonly creatives: number;
  readonly axisProductSize: number;
  readonly feasible: boolean;
  readonly genaiCalls: number;
}

/**
 * VariationPlan — a seeded, distance-checked draw of variants.
 *
 * `policy` and `briefId` are stored so a slot can be re-drawn without the
 * original brief (`briefId` feeds `seedFrom`).
 */
export interface VariationPlan {
  readonly policyHash: string;
  readonly seed: number;
  readonly variants: readonly Variant[];
  readonly estimate: VariationEstimate;
  readonly policy: VariationPolicy;
  readonly briefId: string;
}
