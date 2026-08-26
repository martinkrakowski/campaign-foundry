import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";

/** Input for a copy-pool generation request (object form, not positional). */
export interface CopyGeneratorInput {
  readonly brief: CampaignBrief;
  readonly count: number;
  readonly locale?: string;
}

/**
 * CopyGeneratorPort — outbound port: suggest headline copy for a brief.
 * Implemented by CreativeGeneration (OpenRouter chat). Never called from the
 * per-creative generate loop — pools are built up front and legal-gated once.
 */
export interface CopyGeneratorPort {
  /** Model id the adapter will call — persisted on the pool for provenance. */
  readonly model: string;
  suggestHeadlines(input: CopyGeneratorInput): Promise<readonly string[]>;
}
