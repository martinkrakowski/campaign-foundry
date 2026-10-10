import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
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

describe("PT-8b1 leaves the store layer untouched (N7, N8)", () => {
  // Pinned title (verbatim): "no file under lib/import reads the process environment
  // or names a store adapter class". Scoped to the four NEW lib/import files: scan.ts
  // (not ours) already mentions "FsBriefStore" in a comment, and the Must-not forbids
  // editing it — N8 is about the importer's own code, and these four are it.
  test("no file under lib/import reads the process environment or names a store adapter class", () => {
    const dir = join(projectRoot(), "apps/api/server/lib/import");
    const files = ["import-tenant.ts", "ref-rewrite.ts", "asset-step.ts", "campaign-step.ts"].map(
      (f) => join(dir, f),
    );
    const adapters = ["PgBriefStore", "ObjectAssetStore", "FsAssetStore", "FsBriefStore"];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("process.env");
      for (const name of adapters) {
        expect(source, `${file} names ${name}`).not.toContain(name);
      }
    }
  });
});
