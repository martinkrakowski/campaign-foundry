import { describe, expect, test } from "vitest";
import { IMPORT_ACTOR, importTenant } from "../import-tenant.js";
import type { TenantContext } from "../../tenant.js";

describe("import-tenant", () => {
  test("the import tenant is the import actor with owner role and no team", () => {
    const tenant: TenantContext = importTenant("acme");
    expect(tenant.orgId).toBe("acme");
    expect(tenant.userId).toBe(IMPORT_ACTOR);
    expect(tenant.roles).toEqual(["owner"]);
    expect(tenant.teamIds).toEqual([]);
  });
});
