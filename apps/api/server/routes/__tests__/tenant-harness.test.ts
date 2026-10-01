import { describe, test, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineEventHandler } from "h3";
import { projectRoot, resetProjectRoot } from "@campaignfoundry/shared";
import { database } from "../../lib/db/database.js";
import { storeBackend } from "../../lib/config.js";
import { migratedDatabase } from "../../lib/db/__tests__/pglite-client.js";
import { getLastOpenedStore } from "../../lib/ports/index.js";
import { requestTenant } from "../../lib/tenant.js";
import {
  ACME_TENANT,
  LOCAL_TENANT,
  assertNoLeakedTenantDirs,
  mountTenantRoute,
  setupFsHarness,
  setupPgHarness,
  setupTenantHarness,
  type PgHarness,
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

  // #631, the crossing in miniature and without the timeout that causes it: a
  // test whose body kept running after its budget was gone calls `cleanup()` at
  // a moment another test is mid-flight, and "restore what I found" hands THAT
  // test the process environment this one happened to start in — for the first
  // test in a worker, unset, which is no root at all. With `PROJECT_ROOT`
  // unset, `projectRoot()` walks up from cwd to the checkout, so the live
  // test's next write lands in the repo (`briefs/<slug>/`, gitignored and
  // therefore invisible; `state/last-opened/local.json`, not ignored at all) and
  // the next `sync:check` fails on a tree nobody edited.
  //
  // The pointer is written through the registry rather than a mounted route
  // because that is where the root is resolved (`lib/ports/index.ts`): fs under
  // `<projectRoot>/state/last-opened`, so the assertion can name the file. Both
  // harnesses are fs for the same reason — a pg harness's `getLastOpenedStore`
  // is a `PgLastOpenedStore`, which has no file location to assert.
  test("a stale cleanup cannot hand the checkout to the harness still live", async () => {
    const checkout = process.cwd();
    const stale = setupFsHarness();
    const live = setupFsHarness();
    const backendWhileLive = process.env.STORE_BACKEND;
    try {
      stale.cleanup();

      expect(process.env.PROJECT_ROOT).toBe(live.projectRoot);
      expect(process.env.STORE_BACKEND).toBe(backendWhileLive);

      await getLastOpenedStore(LOCAL_TENANT).write("campaign-1", LOCAL_TENANT.userId);

      expect(existsSync(join(live.projectRoot, "state", "last-opened", "local.json"))).toBe(true);
      expect(existsSync(join(checkout, "state"))).toBe(false);
    } finally {
      live.cleanup();
      // `live` restores what IT found, which was `stale`'s temp root — a
      // directory `stale`'s own cleanup removed. Back to what the worker
      // started with, so the next test in this file inherits nothing.
      delete process.env.PROJECT_ROOT;
      delete process.env.OUTPUT_DIR;
      resetProjectRoot();
      expect(() => assertNoLeakedTenantDirs()).not.toThrow();
    }
  });

  // The same crossing, one step earlier in the story and the one that actually
  // fires on a slow host: the pg setup awaits its migrations, so between setting
  // the roots and returning the harness there is a window in which no harness is
  // registered. A cleanup landing there restored as if it were the last, and
  // handed the test about to run the previous one's root — unset, for the first
  // test in a worker. That one never timed out and never appeared in a trace of
  // a `cleanup`; it wrote `briefs/pointed-at/` into the checkout all the same.
  //
  // A stub database, because what is under test is the ENVIRONMENT the setup
  // installs, not SQL: `makeDb` is gated so the test controls exactly when the
  // setup is mid-flight.
  test("a cleanup landing mid-setup cannot take the roots that setup installed", async () => {
    const checkout = process.cwd();
    let migrate: () => void = () => undefined;
    const migrated = new Promise<void>((resolveGate) => {
      migrate = resolveGate;
    });
    const stubDb = {
      query: async () => ({ rows: [] }),
      exec: async () => undefined,
      transaction: async <T>(work: (tx: never) => Promise<T>) =>
        work({ query: async () => ({ rows: [] }), exec: async () => undefined } as never),
      end: async () => undefined,
    } as unknown as Awaited<ReturnType<typeof migratedDatabase>>;

    const previous = setupFsHarness();
    const inFlight = setupPgHarness(async () => {
      await migrated;
      return stubDb;
    });
    // Mid-setup: `PROJECT_ROOT` already names the pg harness's temp root, but
    // its `setup` has not resolved — and, before the fix, had not registered.
    const rootDuringSetup = process.env.PROJECT_ROOT;
    let harness: PgHarness | undefined;
    try {
      expect(rootDuringSetup).toBeDefined();

      previous.cleanup();
      expect(process.env.PROJECT_ROOT).toBe(rootDuringSetup);

      migrate();
      harness = await inFlight;
      expect(process.env.PROJECT_ROOT).toBe(harness.projectRoot);
      expect(projectRoot()).toBe(harness.projectRoot);
      expect(existsSync(join(checkout, "state"))).toBe(false);
    } finally {
      migrate();
      harness ??= await inFlight.catch(() => undefined);
      await harness?.cleanup();
      previous.cleanup();
      delete process.env.PROJECT_ROOT;
      delete process.env.OUTPUT_DIR;
      delete process.env.STORE_BACKEND;
      resetProjectRoot();
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
