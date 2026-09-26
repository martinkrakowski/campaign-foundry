import { describe, test, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineEventHandler } from "h3";
import { database } from "../../lib/db/database.js";
import { storeBackend } from "../../lib/config.js";
import { migratedDatabase } from "../../lib/db/__tests__/pglite-client.js";
import { requestTenant } from "../../lib/tenant.js";
import {
  ACME_TENANT,
  LOCAL_TENANT,
  assertNoLeakedTenantDirs,
  mountTenantRoute,
  setupFsHarness,
  setupPgHarness,
  setupTenantHarness,
  type TenantContext,
} from "./tenant-harness.js";

describe("tenant-harness (PT-2a item 1)", () => {
  const handler = defineEventHandler((event) => ({ tenant: requestTenant(event) }));

  test("mountTenantRoute mounts behind middleware setting event.context.tenant", async () => {
    const call = mountTenantRoute(handler, ACME_TENANT);
    const res = await call(new Request("http://x/"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant: ACME_TENANT });
  });

  test("mountTenantRoute supports dynamic tenant provider", async () => {
    let current: TenantContext = LOCAL_TENANT;
    const call = mountTenantRoute(handler, {
      method: "get",
      path: "/check",
      tenant: () => current,
    });

    const res1 = await call(new Request("http://x/check"));
    expect(await res1.json()).toEqual({ tenant: LOCAL_TENANT });

    current = ACME_TENANT;
    const res2 = await call(new Request("http://x/check"));
    expect(await res2.json()).toEqual({ tenant: ACME_TENANT });
  });

  test("setupFsHarness creates temporary roots with local at root and acme under orgs/acme", () => {
    const harness = setupFsHarness();
    try {
      expect(harness.backend).toBe("fs");
      expect(existsSync(harness.projectRoot)).toBe(true);
      expect(existsSync(harness.outputRoot)).toBe(true);
      expect(existsSync(harness.acmeRoots.projectRoot)).toBe(true);
      expect(existsSync(harness.acmeRoots.outputRoot)).toBe(true);
      expect(harness.acmeRoots.projectRoot).toBe(join(harness.projectRoot, "orgs", "acme"));
      expect(harness.acmeRoots.outputRoot).toBe(join(harness.outputRoot, "orgs", "acme"));
      expect(process.env.PROJECT_ROOT).toBe(harness.projectRoot);
      expect(process.env.OUTPUT_DIR).toBe(harness.outputRoot);
      expect(storeBackend()).toBe("fs");
    } finally {
      harness.cleanup();
      expect(existsSync(harness.tmpDir)).toBe(false);
    }
  });

  test("setupPgHarness configures STORE_BACKEND=postgres and database mock", async () => {
    const harness = await setupPgHarness();
    try {
      expect(harness.backend).toBe("postgres");
      expect(storeBackend()).toBe("postgres");
      expect(database()).toBe(harness.db);

      const { rows } = await harness.db.query<{ id: string }>(
        "select id from org where id in ('local', 'acme') order by id",
      );
      expect(rows).toEqual([{ id: "acme" }, { id: "local" }]);
    } finally {
      await harness.cleanup();
      expect(existsSync(harness.tmpDir)).toBe(false);
    }
  });

  test("setupTenantHarness dispatches to fs and postgres", async () => {
    const fs = await setupTenantHarness("fs");
    expect(fs.backend).toBe("fs");
    fs.cleanup();

    const pg = await setupTenantHarness("postgres");
    expect(pg.backend).toBe("postgres");
    await pg.cleanup();
  });

  test("assertNoLeakedTenantDirs detects uncleaned temp directories", () => {
    const harness = setupFsHarness();
    try {
      expect(() => assertNoLeakedTenantDirs()).toThrow(/Leaked 1 tenant temp director/);
    } finally {
      harness.cleanup();
      expect(() => assertNoLeakedTenantDirs()).not.toThrow();
    }
  });

  describe("setupPgHarness restores state when a setup step throws", () => {
    const env = () => ({
      root: process.env.PROJECT_ROOT,
      out: process.env.OUTPUT_DIR,
      backend: process.env.STORE_BACKEND,
    });

    test("when the database cannot be created", async () => {
      const before = env();
      await expect(
        setupPgHarness(async () => {
          throw new Error("migrate failed");
        }),
      ).rejects.toThrow("migrate failed");
      expect(env()).toEqual(before);
      expect(() => assertNoLeakedTenantDirs()).not.toThrow();
    });

    test("when seeding the org fails, closing the database it opened", async () => {
      const before = env();
      let closed = false;
      await expect(
        setupPgHarness(async () => {
          const db = await migratedDatabase();
          return {
            ...db,
            query: async () => {
              throw new Error("seed failed");
            },
            end: async () => {
              closed = true;
              await db.end();
            },
          };
        }),
      ).rejects.toThrow("seed failed");
      expect(closed).toBe(true);
      expect(env()).toEqual(before);
      expect(() => assertNoLeakedTenantDirs()).not.toThrow();
    });
  });

  test("setupPgHarness restores state even when closing the database fails", async () => {
    const root = process.env.PROJECT_ROOT;
    await expect(
      setupPgHarness(async () => {
        const db = await migratedDatabase();
        return {
          ...db,
          query: async () => {
            throw new Error("seed failed");
          },
          end: async () => {
            await db.end();
            throw new Error("close failed");
          },
        };
      }),
    ).rejects.toThrow("close failed");
    expect(process.env.PROJECT_ROOT).toBe(root);
    expect(() => assertNoLeakedTenantDirs()).not.toThrow();
  });

  test("cleanup restores state even when closing the database fails", async () => {
    const root = process.env.PROJECT_ROOT;
    let fail = false;
    const harness = await setupPgHarness(async () => {
      const db = await migratedDatabase();
      return {
        ...db,
        end: async () => {
          await db.end();
          if (fail) throw new Error("close failed");
        },
      };
    });
    fail = true;
    await expect(harness.cleanup()).rejects.toThrow("close failed");
    expect(process.env.PROJECT_ROOT).toBe(root);
    expect(() => assertNoLeakedTenantDirs()).not.toThrow();
  });
});
