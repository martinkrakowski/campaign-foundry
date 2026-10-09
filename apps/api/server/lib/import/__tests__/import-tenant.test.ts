import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
import { describe, expect, test } from "vitest";
import { hashBytes } from "../../brief-files.js";
import { IMPORT_STEPS } from "../steps.js";
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

describe("PT-8b1 leaves the CLI unreachable (N1)", () => {
  test("IMPORT_STEPS is still empty and the CLI entry file is unchanged", () => {
    expect(IMPORT_STEPS).toHaveLength(0);
    const cli = readFileSync(join(projectRoot(), "apps/api/bin/import.ts"), "utf8");
    expect(hashBytes(Buffer.from(cli, "utf8"))).toBe(
      "2ccf7bcc171581a4da00c065bc3ad1855f1ad7c9abacca0565f4fc2113a3bc77",
    );
  });
});

describe("PT-8b1 leaves the store layer untouched (N7, N8)", () => {
  test("no new lib/import file reads the process environment or names a store adapter class", () => {
    const dir = join(projectRoot(), "apps/api/server/lib/import");
    const files = [
      "import-tenant.ts",
      "ref-rewrite.ts",
      "asset-step.ts",
      "campaign-step.ts",
    ].map((f) => join(dir, f));
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
