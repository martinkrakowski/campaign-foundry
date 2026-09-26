/**
 * Shared authentication and membership error handling (PT-1b2).
 *
 * Centralizes the handling of:
 * - 401 unauthenticated: redirects to /sign-in
 * - 403 no_membership: throws a typed NoMembershipError
 */

export const NO_ORGANISATION_YET_MESSAGE = "This account belongs to no organisation.";

export class NoMembershipError extends Error {
  readonly code = "no_membership" as const;
  readonly status = 403 as const;

  constructor(message: string = NO_ORGANISATION_YET_MESSAGE) {
    super(message);
    this.name = "NoMembershipError";
    Object.setPrototypeOf(this, NoMembershipError.prototype);
  }
}

export function isNoMembershipError(error: unknown): error is NoMembershipError {
  return (
    error instanceof NoMembershipError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "no_membership")
  );
}

export function handleAuthError(status: number, data: unknown): void {
  // Read once, not twice: `code` and `error` both come off the same record, and a
  // second `typeof data === "object" && data !== null` guard around `error` below
  // would be provably always-true by the time it ran (the 403 branch only runs once
  // `code` — read off this same non-null record — is "no_membership"), which is
  // exactly the kind of unreachable branch a 100%-coverage gate cannot pass.
  const record =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const code = record.code;

  if (status === 401 && (code === "unauthenticated" || code === undefined)) {
    if (typeof window.location.assign === "function") {
      window.location.assign("/sign-in");
    } else {
      window.location.href = "/sign-in";
    }
    return;
  }

  if (status === 403 && code === "no_membership") {
    const errorMsg = record.error;
    throw new NoMembershipError(typeof errorMsg === "string" ? errorMsg : undefined);
  }
}
