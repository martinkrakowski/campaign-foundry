import type { ComplianceResult } from "../../../domain/value-objects/ComplianceResult.vo.js";

/**
 * CompliancePort — outbound port for the compliance circuit breaker. Always
 * resolves a ComplianceResult, never throws; the use case owns the halt decision.
 * Implemented by GovernanceAndCompliance.
 */
export interface CompliancePort {
  /** Text/legal gate: flags prohibited promotional terminology. */
  validateLegalCopy(text: string): Promise<ComplianceResult>;
  /** Visual brand check: brand-colour pixel density against a target hex. */
  validateBrandColorDensity(imageBuffer: Uint8Array, targetHex: string): Promise<ComplianceResult>;
}
