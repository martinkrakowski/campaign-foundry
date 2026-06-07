/**
 * ComplianceResult — the outcome of a compliance check. Always returned, never
 * thrown: the caller (use case) owns the halt decision.
 */
export interface ComplianceResult {
  readonly passed: boolean;
  /** Optional numeric score (e.g. brand-colour density 0..1). Absent for text-only checks like the legal gate. */
  readonly score?: number;
  /** Populated on failure, for telemetry and the review UI. */
  readonly reason?: string;
}
