/**
 * Who a request acts for (D167, stamped 2026-09-24). Authentication will build
 * one per request (PT-1); until then every request and the CLI act as
 * `LOCAL_TENANT`, the single operator this tool has always had. A tenant is an
 * identity, never a location: where its data lives is resolved from it by the
 * composition root (`run-environment.ts`), not carried on it.
 */
export interface TenantContext {
  readonly orgId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  readonly teamIds: readonly string[];
}

/** The one local operator, with every permission, in its own org. */
export const LOCAL_TENANT: TenantContext = Object.freeze({
  orgId: "local",
  userId: "local",
  roles: Object.freeze(["owner"]),
  teamIds: Object.freeze([]),
});
