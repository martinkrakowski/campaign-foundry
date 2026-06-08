/**
 * Normalize an unknown caught value to a message string. Centralizes the
 * `error instanceof Error ? error.message : String(error)` pattern so call sites
 * stay branch-free (and the one defensive non-Error branch is tested in one place).
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
