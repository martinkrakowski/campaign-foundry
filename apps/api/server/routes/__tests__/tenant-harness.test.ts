import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineEventHandler } from "h3";
import { projectRoot, resetProjectRoot } from "@campaignfoundry/shared";
import { database, resetDatabase, setDatabase } from "../../lib/db/database.js";
import { storeBackend } from "../../lib/config.js";
import { migratedDatabase } from "../../lib/db/__tests__/pglite-client.js";
import { getLastOpenedStore } from "../../lib/ports/index.js";
import { requestTenant } from "../../lib/tenant.js";
import {
  ACME_TENANT,
  LOCAL_TENANT,
  assertNoLeakedTenantDirs,
  assertNoNewState,
  checkoutRoot,
  mountTenantRoute,
  setupFsHarness,
  setupPgHarness,
  setupTenantHarness,
  snapshotState,
  type PgHarness,
  type TenantContext,
} from "./tenant-harness.js";

/**
 * A database that answers the seed and nothing else. Every test below is about
 * the ENVIRONMENT a setup installs and about who may restore it — never about
 * SQL — so a stub keeps them at tens of milliseconds instead of the two real
 * pg boots a `migratedDatabase()` per harness costs, which on a loaded host is
 * more than the 5 s a test is given.
 */
function stubDatabase(): Awaited<ReturnType<typeof migratedDatabase>> {
  return {
    query: async () => ({ rows: [] }),
    exec: async () => undefined,
    transaction: async <T>(work: (tx: never) => Promise<T>) =>
      work({ query: async () => ({ rows: [] }), exec: async () => undefined } as never),
    end: async () => undefined,
  } as unknown as Awaited<ReturnType<typeof migratedDatabase>>;
}

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
  //
  // The checkout's own `state/` is snapshotted HERE, before either setup, and
  // compared afterwards: a developer's `yarn dev` has already put one there, and
  // that is not this test's doing (see `assertNoNewState`).
  test("a stale cleanup cannot hand the checkout to the harness still live", async () => {
    const checkout = checkoutRoot();
    const checkoutBefore = snapshotState(checkout);
    const stale = setupFsHarness();
    const live = setupFsHarness();
    const backendWhileLive = process.env.STORE_BACKEND;
    try {
      stale.cleanup();

      expect(process.env.PROJECT_ROOT).toBe(live.projectRoot);
      expect(process.env.STORE_BACKEND).toBe(backendWhileLive);

      await getLastOpenedStore(LOCAL_TENANT).write("campaign-1", LOCAL_TENANT.userId);

      expect(existsSync(join(live.projectRoot, "state", "last-opened", "local.json"))).toBe(true);
      expect(() => assertNoNewState(checkout, checkoutBefore)).not.toThrow();
    } finally {
      live.cleanup();
      // `live` restores what IT found, which was `stale`'s temp root — a
      // directory `stale`'s own cleanup removed. Back to what the worker
      // started with, so the next test in this file inherits nothing.
      delete process.env.PROJECT_ROOT;
      delete process.env.OUTPUT_DIR;
      delete process.env.STORE_BACKEND;
      resetProjectRoot();
      // These two temp dirs, not `assertNoLeakedTenantDirs()`: that is a
      // file-wide claim, and a pg test in this file that overruns its budget on
      // a slow host leaves its own behind, which would make this test report
      // someone else's leak as its own failure.
      expect(existsSync(stale.tmpDir)).toBe(false);
      expect(existsSync(live.tmpDir)).toBe(false);
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
    const checkout = checkoutRoot();
    const checkoutBefore = snapshotState(checkout);
    let migrate: () => void = () => undefined;
    const migrated = new Promise<void>((resolveGate) => {
      migrate = resolveGate;
    });
    const stubDb = stubDatabase();

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
      expect(() => assertNoNewState(checkout, checkoutBefore)).not.toThrow();
    } finally {
      migrate();
      harness ??= await inFlight.catch(() => undefined);
      await harness?.cleanup();
      previous.cleanup();
      delete process.env.PROJECT_ROOT;
      delete process.env.OUTPUT_DIR;
      delete process.env.STORE_BACKEND;
      resetProjectRoot();
      expect(existsSync(previous.tmpDir)).toBe(false);
      if (harness) expect(existsSync(harness.tmpDir)).toBe(false);
    }
  });

  // A setup that failed LATE, from a body that overran its budget before the
  // failure: the same crossing as the cleanup above, one path earlier. It used
  // to restore unconditionally — handing the live test an unset root — and to
  // call `resetDatabase()`, which unmounts the live harness's mock outright.
  test("a setup failing late cannot restore over the harness set up on top of it", async () => {
    let fail: () => void = () => undefined;
    const failed = new Promise<never>((_, rejectGate) => {
      fail = () => rejectGate(new Error("migrate failed"));
    });
    // The pg setup first and the fs harness on top of it, because that is the
    // order the failure has to be judged in: what this setup restores is what
    // it found BEFORE the fs harness existed, so a restore lands the live
    // harness's test back on the worker's own environment.
    const inFlight = setupPgHarness(() => failed);
    const live = setupFsHarness();

    try {
      // The pg setup is mid-migration with a newer harness registered on top;
      // its database creation now fails.
      fail();
      await expect(inFlight).rejects.toThrow("migrate failed");

      expect(process.env.PROJECT_ROOT).toBe(live.projectRoot);
      expect(process.env.OUTPUT_DIR).toBe(live.outputRoot);
      expect(process.env.STORE_BACKEND).toBeUndefined();
      // The live harness keeps its own project root, memoized and whole.
      expect(projectRoot()).toBe(live.projectRoot);
    } finally {
      await inFlight.catch(() => undefined);
      live.cleanup();
      delete process.env.PROJECT_ROOT;
      delete process.env.OUTPUT_DIR;
      delete process.env.STORE_BACKEND;
      resetProjectRoot();
      expect(existsSync(live.tmpDir)).toBe(false);
    }
  });

  // An abandoned setup: its body overran its budget, and a newer harness
  // registered on top of it while its migrations ran. It must adopt nothing —
  // no `setDatabase` over the live mock, no resets over the live caches — and
  // reject, which is the only answer the abandoned body can still use.
  //
  // It must also not get as far as the org seed, which is what separates the
  // FIRST guard from the second one: this setup is already stale by the time
  // `makeDb()` resolves, so the seed below is a write into a database the setup
  // is about to throw away — and the only guard standing in front of it is the
  // one that runs immediately after `makeDb()`.
  test("a setup abandoned under a newer harness rejects and adopts nothing", async () => {
    let migrate: () => void = () => undefined;
    const migrated = new Promise<void>((resolveGate) => {
      migrate = resolveGate;
    });
    const queries: string[] = [];
    const db = stubDatabase();
    // The pg setup first, so the fs harness below registers ON TOP of it: that
    // is what makes this setup stale by the time its migrations finish.
    const abandoned = setupPgHarness(async () => {
      await migrated;
      return {
        ...db,
        query: async (text: string, params?: readonly unknown[]) => {
          queries.push(text);
          return db.query(text, params);
        },
      } as unknown as Awaited<ReturnType<typeof migratedDatabase>>;
    });
    const live = setupFsHarness();

    try {
      migrate();
      await expect(abandoned).rejects.toThrow("abandoned");

      expect(queries).toEqual([]);
      expect(process.env.PROJECT_ROOT).toBe(live.projectRoot);
      expect(process.env.OUTPUT_DIR).toBe(live.outputRoot);
      expect(storeBackend()).toBe("fs");
      expect(projectRoot()).toBe(live.projectRoot);
    } finally {
      migrate();
      await abandoned.catch(() => undefined);
      live.cleanup();
      delete process.env.PROJECT_ROOT;
      delete process.env.OUTPUT_DIR;
      delete process.env.STORE_BACKEND;
      resetProjectRoot();
      expect(existsSync(live.tmpDir)).toBe(false);
    }
  });

  // The seed is the LAST await before adoption, so a harness that registers
  // during it is as live as one that registered during the migrations. This
  // setup had already passed the first guard when the seed began, and it used
  // to go on to mount its database over that harness's mock and empty its
  // caches — a guard that ran, and did not help. The seed is gated through the
  // injected `makeDb`, so nothing in the harness itself had to change to hold
  // the window open; and the fs harness is registered only once the test has
  // SEEN the seed reached, because registering it earlier would simply trip the
  // first guard and prove nothing about the second.
  test("a setup abandoned during the org seed rejects and mounts nothing", async () => {
    let seed: () => void = () => undefined;
    const seeded = new Promise<void>((resolveGate) => {
      seed = resolveGate;
    });
    let reachedSeed: () => void = () => undefined;
    const atSeed = new Promise<void>((resolveGate) => {
      reachedSeed = resolveGate;
    });
    const db = stubDatabase();
    const gatedDb = {
      ...db,
      query: async (text: string, params?: readonly unknown[]) => {
        if (text.startsWith("insert into org")) {
          reachedSeed();
          await seeded;
        }
        return db.query(text, params);
      },
    } as unknown as Awaited<ReturnType<typeof migratedDatabase>>;
    // A database already mounted, so "the abandoned setup mounted nothing" is
    // answerable: `database()` must still be this one, not the abandoned db.
    const mounted = stubDatabase();
    resetDatabase();
    setDatabase(mounted);

    const abandoned = setupPgHarness(async () => gatedDb);
    await atSeed;
    const live = setupFsHarness();

    try {
      seed();
      await expect(abandoned).rejects.toThrow("abandoned");

      expect(database()).toBe(mounted);
      expect(database()).not.toBe(gatedDb);
      expect(process.env.PROJECT_ROOT).toBe(live.projectRoot);
      expect(process.env.OUTPUT_DIR).toBe(live.outputRoot);
      expect(process.env.STORE_BACKEND).toBeUndefined();
      expect(projectRoot()).toBe(live.projectRoot);
    } finally {
      seed();
      await abandoned.catch(() => undefined);
      live.cleanup();
      resetDatabase();
      delete process.env.PROJECT_ROOT;
      delete process.env.OUTPUT_DIR;
      delete process.env.STORE_BACKEND;
      resetProjectRoot();
      expect(existsSync(live.tmpDir)).toBe(false);
    }
  });

  // The pg half of the stale-cleanup rule, which the fs test above cannot reach:
  // a stale pg cleanup must leave the live harness's database MOCK mounted. It
  // used to call `resetDatabase()` on its way out, and `database()` then built a
  // real client from the environment — which has no `DATABASE_URL` under test,
  // so every store in the live test threw instead.
  test("a stale pg cleanup leaves the live harness's database mounted", async () => {
    const stale = await setupPgHarness(async () => stubDatabase());
    const live = await setupPgHarness(async () => stubDatabase());
    try {
      await stale.cleanup();

      expect(database()).toBe(live.db);
      expect(storeBackend()).toBe("postgres");
      expect(process.env.PROJECT_ROOT).toBe(live.projectRoot);

      await live.cleanup();
      delete process.env.PROJECT_ROOT;
      delete process.env.OUTPUT_DIR;
      delete process.env.STORE_BACKEND;
      resetProjectRoot();
    } finally {
      // `stale` is already cleaned up and `live` may not be, so both cleanups
      // are safe to call again: the second is stale and removes only its own
      // temp dir.
      stale.cleanup();
      await live.cleanup();
      resetDatabase();
      delete process.env.PROJECT_ROOT;
      delete process.env.OUTPUT_DIR;
      delete process.env.STORE_BACKEND;
      resetProjectRoot();
      expect(existsSync(stale.tmpDir)).toBe(false);
      expect(existsSync(live.tmpDir)).toBe(false);
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

  // The checkout check is a BASELINE check, and it is exercised here against a
  // temp directory that stands in for a checkout — never by planting a `state/`
  // in the real one, which would turn this file's own module-load baseline red
  // and hand every other harness-importing file the same false failure. What a
  // developer's `yarn dev` leaves there is the reason the check exists in this
  // shape rather than as an existence test.
  describe("assertNoNewState over a root that already has state", () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "cf-state-baseline-"));
      mkdirSync(join(root, "state", "last-opened"), { recursive: true });
      writeFileSync(join(root, "state", "last-opened", "x.json"), "{}", "utf8");
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    test("a state/ that was already there is not this suite's doing", () => {
      const baseline = snapshotState(root);

      expect([...baseline.keys()]).toEqual(["last-opened/x.json"]);
      expect(() => assertNoNewState(root, baseline)).not.toThrow();
    });

    test("a pointer written into it afterwards is", () => {
      const baseline = snapshotState(root);

      writeFileSync(join(root, "state", "last-opened", "local.json"), "{}", "utf8");

      expect(() => assertNoNewState(root, baseline)).toThrow(
        /1 changed path\(s\) under .*state:\nlast-opened\/local\.json \(new\)/,
      );
    });

    // The overwrite is the case a path set cannot see, and the pointer is
    // written by rename-over (`fs-last-opened-store.ts`), so a second write
    // leaves the same path with different bytes. The mtime is bumped explicitly
    // rather than waited for, so the test asserts the CHECK and not the clock.
    test("a pointer OVERWRITTEN in place is caught too", () => {
      const baseline = snapshotState(root);
      const pointer = join(root, "state", "last-opened", "x.json");

      writeFileSync(pointer, '{"campaignId":"second","updatedAt":"later"}', "utf8");
      const later = new Date(Date.now() + 10_000);
      utimesSync(pointer, later, later);

      expect(() => assertNoNewState(root, baseline)).toThrow(
        /1 changed path\(s\) under .*state:\nlast-opened\/x\.json \(rewritten\)/,
      );
      // …and the bytes are not the only thing that distinguishes the two: a
      // rewrite to the same length is still a rewrite.
      expect(baseline.get("last-opened/x.json")?.size).not.toBe(
        snapshotState(root).get("last-opened/x.json")?.size,
      );
    });

    test("a root with no state/ at all has an empty baseline", () => {
      const bare = mkdtempSync(join(tmpdir(), "cf-state-bare-"));
      try {
        expect(snapshotState(bare).size).toBe(0);
        expect(() => assertNoNewState(bare, snapshotState(bare))).not.toThrow();

        mkdirSync(join(bare, "state"), { recursive: true });
        expect(() => assertNoNewState(bare, snapshotState(bare))).not.toThrow();

        writeFileSync(join(bare, "state", "u1.json"), "{}", "utf8");
        expect(() => assertNoNewState(bare, new Map())).toThrow(/u1\.json/);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });
  });
});
