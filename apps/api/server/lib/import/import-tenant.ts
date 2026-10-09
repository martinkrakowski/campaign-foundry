import type { TenantContext } from "../tenant.js";

export const IMPORT_ACTOR = "import:pt-8";

export function importTenant(orgId: string): TenantContext {
  return {
    orgId,
    userId: IMPORT_ACTOR,
    roles: Object.freeze(["owner"]),
    teamIds: Object.freeze([]),
  };
}
