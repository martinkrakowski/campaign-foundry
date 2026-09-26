import { auth } from "../lib/auth/instance.js";
import { memberTenant } from "../lib/auth/membership.js";
import { authMode } from "../lib/config.js";
import { database } from "../lib/db/database.js";

/**
 * Requests no session is required for (PT-1a item 3): Better Auth's own
 * routes (sign-in, callbacks, session polling), the health check, and the
 * capability probe the web app polls at boot (it reveals host capabilities,
 * the auth mode and whether Google sign-in is configured, never tenant data).
 */
function isAllowlisted(method: string, pathname: string): boolean {
  if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return true;
  if (method === "GET" && pathname === "/") return true;
  if (method === "GET" && pathname === "/campaigns/capabilities") return true;
  return false;
}

/**
 * Turns a Better Auth session into `event.context.tenant` (PT-1a item 3,
 * D167). A no-op under `AUTH_MODE=local`: `requestTenant` (`lib/tenant.ts`)
 * falls back to `LOCAL_TENANT` on its own, and running Better Auth's session
 * lookup on every local request would be pure overhead for a mode that never
 * has a session to find.
 *
 * Unauthenticated → 401, except the allowlist above. Authenticated with no
 * membership → 403 `{ code: "no_membership" }`, so PT-1b can route a
 * signed-up-but-unassigned user somewhere useful instead of a wall of errors.
 */
export default defineEventHandler(async (event) => {
  if (authMode() !== "better-auth") return;
  const pathname = event.path.split("?")[0];
  if (isAllowlisted(event.method, pathname)) return;

  const session = await auth().api.getSession({ headers: event.headers });
  if (!session) {
    setResponseStatus(event, 401);
    return { error: "Sign in required.", code: "unauthenticated" };
  }

  const activeOrgId = (session.session as { activeOrganizationId?: string | null } | undefined)
    ?.activeOrganizationId;
  const tenant = await memberTenant(database(), session.user.id, activeOrgId);
  if (!tenant) {
    setResponseStatus(event, 403);
    return { error: "This account belongs to no organisation.", code: "no_membership" };
  }

  event.context.tenant = tenant;
  return undefined;
});
