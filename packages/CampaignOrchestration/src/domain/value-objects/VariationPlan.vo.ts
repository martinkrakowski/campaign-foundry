import type { Variant } from "../entities/Variant.js";
import type { VariationPolicy } from "./VariationPolicy.vo.js";

export interface VariationEstimate {
  readonly creatives: number;
  readonly axisProductSize: number;
  readonly feasible: boolean;
  readonly genaiCalls: number;
  /** Total frames to encode (Σ durationSec × fps over motion variants). Motion plans only. */
  readonly frames?: number;
  /**
   * Present (and `true`) only when the brief's timeline names at least one
   * per-beat scene (VE5b2). Since VE5a a scene is an uploaded asset path, never
   * a generated one, so it never adds to `genaiCalls` — this tells the
   * estimate sentence whether to say scenes reuse uploaded images and add no
   * AI calls. Absent (never `false`) for a brief with no timeline or one
   * naming no backgrounds, so a scene-free plan's JSON stays byte-identical.
   */
  readonly sceneBackgrounds?: true;
}

/**
 * VariationPlan — a seeded, distance-checked draw of variants.
 *
 * `policy` and `briefId` are stored so a slot can be re-drawn without the
 * original brief (`briefId` feeds `seedFrom`).
 */
export interface VariationPlan {
  readonly policyHash: string;
  /**
   * Hash of the brief's copy surface (§35) — independent of `policyHash`,
   * carried beside it so a re-roll can pin both. `replan` never recomputes
   * this: it re-draws one slot's axes, never the brief's copy, so the hash a
   * plan was built with stays valid across every `replan` of it.
   */
  readonly copyHash: string;
  readonly seed: number;
  readonly variants: readonly Variant[];
  readonly estimate: VariationEstimate;
  readonly policy: VariationPolicy;
  readonly briefId: string;
}
