/**
 * The brief schema version (D133).
 *
 * Required in the domain, defaulted at the boundary.
 */
export const BRIEF_SCHEMA_VERSION = 1 as const;

export function isSupportedBriefSchemaVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= BRIEF_SCHEMA_VERSION;
}
