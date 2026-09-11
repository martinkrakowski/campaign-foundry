/** Severity classification for compliance findings. */
export type ComplianceSeverity = "error" | "advisory";

/**
 * ComplianceResult — the outcome of a compliance check. Always returned, never
 * thrown: the caller (use case) owns the halt decision.
 *
 * Three states are represented:
 * - Passed silently: `{ passed: true }` (no reason, no severity).
 * - Passed with advisory: `{ passed: true, severity: "advisory", reason: "..." }`.
 *   Advisories inform telemetry and review without halting compliance gates.
 * - Failed: `{ passed: false, reason: "...", severity?: "error" }`.
 */
export interface ComplianceResult {
  readonly passed: boolean;
  /** Optional numeric score (e.g. brand-colour density 0..1). Absent for text-only checks like the legal gate. */
  readonly score?: number;
  /** Populated on failure or advisory, explaining the verdict for telemetry and the review UI. */
  readonly reason?: string;
  /** Explicit severity of the finding when present ("advisory" for non-halting warnings, "error" for failures). */
  readonly severity?: ComplianceSeverity;
}
