import { describe, test, expect } from "vitest";
import { join } from "node:path";
import { runEnvironment, tenantOutputRoot } from "../run-environment.js";
import { LOCAL_TENANT, type TenantContext } from "../tenant.js";

const org = (orgId: string): TenantContext => ({ ...LOCAL_TENANT, orgId, userId: "u1" });

describe("tenantOutputRoot (PT-0c)", () => {
  test("the local operator keeps the process output root, so nothing on disk moves", () => {
    expect(tenantOutputRoot("/out", LOCAL_TENANT)).toBe("/out");
  });

  test("any other org gets its own root beneath it", () => {
    expect(tenantOutputRoot("/out", org("acme"))).toBe(join("/out", "orgs", "acme"));
    expect(tenantOutputRoot("/out", org("globex"))).not.toBe(tenantOutputRoot("/out", org("acme")));
  });

  test("an org id that is not a safe path segment is refused, never joined", () => {
    for (const orgId of ["../acme", "acme/x", "", "ACME"]) {
      expect(() => tenantOutputRoot("/out", org(orgId)), orgId).toThrow(/is not a safe id/);
    }
  });

  test("runEnvironment resolves a tenant's own output root", () => {
    const local = runEnvironment(LOCAL_TENANT);
    expect(runEnvironment(org("acme")).outputRoot).toBe(join(local.outputRoot, "orgs", "acme"));
  });
});
