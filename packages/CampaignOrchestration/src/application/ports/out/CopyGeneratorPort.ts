import type { CampaignBrief } from "../../../domain/entities/CampaignBrief.js";

/** Input for a copy-pool generation request (object form, not positional). */
export interface CopyGeneratorInput {
  readonly brief: CampaignBrief;
  readonly count: number;
  readonly locale?: string;
}

/**
 * Why a copy generation failed, so the edge can map it to an HTTP status
 * without knowing the adapter:
 *   missing_key  — no credentials configured (503 naming the env var)
 *   auth         — upstream rejected the credentials (502, sanitised)
 *   rate_limited — upstream 429 (`retryAfterSeconds` when the upstream said)
 *   network      — connection failure or timeout (503)
 *   upstream     — any other non-2xx upstream reply (502)
 *   malformed    — 2xx but the body was not the agreed JSON shape (422)
 */
export type CopyGeneratorErrorKind = "missing_key" | "auth" | "rate_limited" | "network" | "upstream" | "malformed";

export class CopyGeneratorError extends Error {
  readonly kind: CopyGeneratorErrorKind;
  readonly retryAfterSeconds?: number;

  constructor(kind: CopyGeneratorErrorKind, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "CopyGeneratorError";
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * CopyGeneratorPort — outbound port: suggest headline copy for a brief.
 * Implemented by CreativeGeneration (OpenRouter chat). Never called from the
 * per-creative generate loop — pools are built up front and legal-gated once.
 * Failures reject with `CopyGeneratorError`.
 */
export interface CopyGeneratorPort {
  /** Model id the adapter will call — persisted on the pool for provenance. */
  readonly model: string;
  suggestHeadlines(input: CopyGeneratorInput): Promise<readonly string[]>;
}
