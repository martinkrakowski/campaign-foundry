import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";
import type { PipelineResult } from "../../../domain/value-objects/PipelineResult.vo.js";
import type { Result } from "@campaignfoundry/shared";

/**
 * Classic cell identity: product × canvas × treatment, where the canvas is a
 * social `aspectRatio` or a display `size` (D113) — exactly one of the two.
 * A ratio-only payload stays byte-identical to the pre-display target shape,
 * so existing HITL payloads keep working.
 */
export interface ClassicRegenerationTarget {
  readonly productId: string;
  /** Social cells only; display cells carry `size` instead. */
  readonly aspectRatio?: string;
  /** Display cells only (the `728x90` form, not a slug); ratio cells omit it. */
  readonly size?: string;
  readonly treatment: string;
}

/**
 * Variation slot identity: product + variantIndex (D6). `attempt` is the re-roll
 * counter passed through to `replan(plan, index, attempt)` — originals are 0,
 * so a re-roll must send `>= 1` (`previous + 1`). Omitted defaults to 1.
 */
export interface VariationRegenerationTarget {
  readonly productId: string;
  readonly variantIndex: number;
  readonly attempt?: number;
}

/**
 * A single creative cell to regenerate. Presence of numeric `variantIndex` is
 * the discriminator (D6).
 */
export type RegenerationTarget = ClassicRegenerationTarget | VariationRegenerationTarget;

/** True when the target addresses a variation slot rather than a classic cell. */
export function isVariationTarget(t: RegenerationTarget): t is VariationRegenerationTarget {
  return "variantIndex" in t && typeof t.variantIndex === "number";
}

/** Optional run modifiers passed alongside a brief. */
export interface CampaignExecutionOptions {
  /**
   * When present, only these creatives are (re)generated; every other cell is
   * skipped. Used by the HITL loop to re-roll just the rejected creatives without
   * disturbing approved ones. Absent → full campaign run (every cell).
   */
  readonly regenerateOnly?: ReadonlyArray<RegenerationTarget>;
}

/**
 * CampaignPipelinePort — the single inbound entry-point contract. Every driving
 * adapter (the Nitro route, the CLI) invokes this port and never bypasses it.
 */
export interface CampaignPipelinePort {
  execute(
    brief: CampaignBrief,
    options?: CampaignExecutionOptions,
  ): Promise<Result<PipelineResult, Error>>;
}
