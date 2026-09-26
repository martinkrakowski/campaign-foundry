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
  const code =
    typeof data === "object" && data !== null ? (data as { code?: unknown }).code : undefined;

  if (status === 401 && (code === "unauthenticated" || code === undefined)) {
    if (typeof window.location.assign === "function") {
      window.location.assign("/sign-in");
    } else {
      window.location.href = "/sign-in";
    }
    return;
  }

  if (status === 403 && code === "no_membership") {
    const errorMsg =
      typeof data === "object" && data !== null ? (data as { error?: unknown }).error : undefined;
    throw new NoMembershipError(typeof errorMsg === "string" ? errorMsg : undefined);
  }
}
