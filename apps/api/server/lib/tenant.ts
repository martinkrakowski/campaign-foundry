import type { H3Event } from "h3";
import { authMode } from "./config.js";

/**
 * Who a request acts for (D167, stamped 2026-09-24). Authentication builds one
 * per request (PT-1, `requestTenant` below); under `AUTH_MODE=local` every
 * request and the CLI still act as `LOCAL_TENANT`, the single operator this
 * tool has always had. A tenant is an identity, never a location: where its
 * data lives is resolved from it by the composition root (`run-environment.ts`),
 * not carried on it.
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

declare module "h3" {
  interface H3EventContext {
    /** Set by `server/middleware/tenant.ts` once a session resolves to a member. */
    tenant?: TenantContext;
  }
}

/**
 * The tenant a request acts for (PT-1a item 2): every route calls this instead
 * of naming `LOCAL_TENANT` directly, so switching `AUTH_MODE` needs no route
 * change.
 *
 * Under `local`, `event.context.tenant` is never set (the middleware short-circuits
 * before touching it — see `server/middleware/tenant.ts`), so every request acts as
 * `LOCAL_TENANT`, exactly as before PT-1. That keeps every route test, which mounts
 * a handler on a bare h3 app with no middleware, passing unchanged.
 *
 * Under `better-auth`, the middleware has already turned the session into a
 * tenant (401) and checked membership (403) before any route runs, so a missing
 * `event.context.tenant` here means the middleware did not run for this
 * request — a wiring bug, not a request to handle, hence the throw rather than
 * a silent `LOCAL_TENANT` fallback that would hand one tenant's route another's
 * data.
 */
export function requestTenant(event: H3Event): TenantContext {
  if (authMode() === "local") return event.context.tenant ?? LOCAL_TENANT;
  if (!event.context.tenant) {
    throw new Error(
      "event.context.tenant is missing under AUTH_MODE=better-auth: the tenant middleware did not run for this request.",
    );
  }
  return event.context.tenant;
}
