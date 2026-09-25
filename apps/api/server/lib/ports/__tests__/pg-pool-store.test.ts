import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CopyPool } from "@campaignfoundry/CampaignOrchestration";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { LOCAL_TENANT, type TenantContext } from "../../tenant.js";
import { runEnvironment } from "../../run-environment.js";
import { getPoolStore, resetPoolStore, setPoolStore, type PoolStorePort } from "../index.js";
import { InvalidCopyPoolError } from "../pool-store.port.js";
import { FsPoolStore } from "../fs-pool-store.js";
import { PgPoolStore } from "../pg-pool-store.js";

const acme: TenantContext = { ...LOCAL_TENANT, orgId: "acme", userId: "u1" };

const pool = (over: Partial<CopyPool> = {}): CopyPool => ({
  briefId: "camp",
  generatedAt: "2026-01-01T00:00:00.000Z",
  model: "openai/gpt-4o-mini",
  entries: [{ id: "h1", text: "Stay wild", status: "approved" }],
  ...over,
});

describe("PgPoolStore (PT-3e, D169)", () => {
  let db: SqlClient;
  beforeEach(async () => {
    db = await migratedDatabase();
    await db.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
  });
  afterEach(async () => {
    await db.end();
  });

  test("writePool then readPool round-trip, and readPool answers undefined when nothing is stored", async () => {
    const store = new PgPoolStore(db, "local");
    expect(await store.readPool("camp")).toBeUndefined();
    const value = pool();
    const stored = await store.writePool(value);
    expect(stored.pool).toEqual(value);
    expect(await store.readPool("camp")).toEqual(stored);
  });

  test("the revision equals FsPoolStore's for the same pool, so an import keeps it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cf-pg-pool-"));
    try {
      const value = pool();
      const onFiles = await new FsPoolStore(dir).writePool(value);
      const onDb = await new PgPoolStore(db, "local").writePool(value);
      expect(onDb.revision).toBe(onFiles.revision);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stale expected revision is refused with ECONFLICT carrying the current revision, and nothing is written", async () => {
    const store = new PgPoolStore(db, "local");
    const first = await store.writePool(pool());
    const second = await store.writePool(
      pool({ entries: [{ id: "h2", text: "Stay hydrated", status: "approved" }] }),
    );
    expect(second.revision).not.toBe(first.revision);

    await expect(
      store.writePool(pool({ entries: [] }), { expectedRevision: first.revision }),
    ).rejects.toMatchObject({
      message: "Headline pool was modified by another user.",
      code: "ECONFLICT",
      revision: second.revision,
    });
    // The refused write left the stored bytes alone.
    expect((await store.readPool("camp"))?.pool.entries).toHaveLength(1);
  });

  test("a conditional write onto an unwritten campaign conflicts with no revision", async () => {
    const store = new PgPoolStore(db, "local");
    await expect(
      store.writePool(pool({ briefId: "fresh" }), { expectedRevision: "no-such-revision" }),
    ).rejects.toMatchObject({ code: "ECONFLICT", revision: undefined });
    expect(await store.readPool("fresh")).toBeUndefined();
  });

  test("writePool accepts the revision it just read and returns the new one", async () => {
    const store = new PgPoolStore(db, "local");
    const first = await store.writePool(pool());
    const next = await store.writePool(pool({ entries: [] }), { expectedRevision: first.revision });
    expect(next.revision).not.toBe(first.revision);
    expect((await store.readPool("camp"))?.pool.entries).toEqual([]);
  });

  test("a write without an expectation is unconditional, overwriting whatever is stored", async () => {
    const store = new PgPoolStore(db, "local");
    await store.writePool(pool());
    await store.writePool(
      pool({ entries: [{ id: "h2", text: "Stay hydrated", status: "approved" }] }),
    );
    const third = await store.writePool(pool({ entries: [] }));
    expect((await store.readPool("camp"))?.pool.entries).toEqual([]);
    expect(third.pool.entries).toEqual([]);
  });

  test("copyPool copies within the org and rewrites the pool's own briefId; undefined when the source is absent", async () => {
    const store = new PgPoolStore(db, "local");
    expect(await store.copyPool("camp", "copy")).toBeUndefined();
    await store.writePool(pool());
    const copied = await store.copyPool("camp", "copy");
    expect(copied).toMatchObject({ briefId: "copy", entries: [{ id: "h1" }] });
    expect((await store.readPool("copy"))?.pool.briefId).toBe("copy");
    // The source is untouched.
    expect((await store.readPool("camp"))?.pool.briefId).toBe("camp");
  });

  test("copyPool refuses an unsafe destination id exactly as the fs store does, even with no source pool", async () => {
    const store = new PgPoolStore(db, "local");
    await expect(store.copyPool("absent", "../evil")).rejects.toThrow(
      /Path escapes the allowed directory/,
    );
  });

  test("deletePool removes the row and is a no-op when it is already absent", async () => {
    const store = new PgPoolStore(db, "local");
    await store.writePool(pool());
    await store.deletePool("camp");
    expect(await store.readPool("camp")).toBeUndefined();
    await expect(store.deletePool("camp")).resolves.toBeUndefined();
  });

  test("isPoolDirSymlink is always false", async () => {
    const store = new PgPoolStore(db, "local");
    await expect(store.isPoolDirSymlink("camp")).resolves.toBe(false);
    await store.writePool(pool());
    await expect(store.isPoolDirSymlink("camp")).resolves.toBe(false);
  });

  test("readPool rejects an invalid stored pool the same way the fs store does", async () => {
    const store = new PgPoolStore(db, "local");
    const seed = async (campaignId: string, body: string) => {
      await db.query(
        `insert into pool (org_id, campaign_id, body, revision, updated_at)
         values ($1, $2, $3, $4, now())`,
        ["local", campaignId, body, `rev-${campaignId}`],
      );
    };

    await seed("bad-json", "{not-json");
    await expect(store.readPool("bad-json")).rejects.toThrow(InvalidCopyPoolError);
    await expect(store.readPool("bad-json")).rejects.toThrow(/not JSON/);

    await seed("bad-shape", JSON.stringify({ generatedAt: "t", model: "m", entries: [] }));
    await expect(store.readPool("bad-shape")).rejects.toThrow(InvalidCopyPoolError);
    await expect(store.readPool("bad-shape")).rejects.toThrow(/briefId must be a string/);

    await seed("mine", JSON.stringify(pool({ briefId: "other" })));
    await expect(store.readPool("mine")).rejects.toThrow(InvalidCopyPoolError);
    await expect(store.readPool("mine")).rejects.toThrow(
      'briefId "other" does not match storage key "mine".',
    );
  });

  test("org isolation: another org's pool is invisible, and each org's writes are separate", async () => {
    const local = new PgPoolStore(db, "local");
    const acmeStore = new PgPoolStore(db, "acme");
    await local.writePool(pool());
    expect(await acmeStore.readPool("camp")).toBeUndefined();
    await acmeStore.writePool(pool({ entries: [] }));
    expect((await local.readPool("camp"))?.pool.entries).toHaveLength(1);
    expect((await acmeStore.readPool("camp"))?.pool.entries).toEqual([]);
  });

  test("an unsafe campaign id is refused the same way the fs store refuses a traversing id", async () => {
    const store = new PgPoolStore(db, "local");
    await expect(store.readPool("../evil")).rejects.toThrow(/Path escapes the allowed directory/);
    await expect(store.writePool(pool({ briefId: "../evil" }))).rejects.toThrow(
      /Path escapes the allowed directory/,
    );
  });

  test("withPoolLock serialises critical sections per campaign id", async () => {
    const store = new PgPoolStore(db, "local");
    const order: string[] = [];
    let unlock: () => void = () => {};
    const lock = new Promise<void>((r) => (unlock = r));

    const p1 = store.withPoolLock("camp", async () => {
      await lock;
      order.push("p1");
    });
    const p2 = store.withPoolLock("camp", async () => {
      order.push("p2");
    });
    const pOther = store.withPoolLock("other", async () => {
      order.push("pOther");
    });

    await pOther;
    expect(order).toEqual(["pOther"]);
    unlock();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["pOther", "p1", "p2"]);
  });

  test("withPoolLock keeps serving a campaign id after a section rejects", async () => {
    const store = new PgPoolStore(db, "local");
    await expect(
      store.withPoolLock("camp", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.withPoolLock("camp", async () => "ok")).toBe("ok");
  });

  test("an org with no row cannot hold a pool", async () => {
    await expect(new PgPoolStore(db, "ghost").writePool(pool())).rejects.toThrow();
  });
});

describe("STORE_BACKEND=postgres puts pools in the database, one store per org (PT-3e)", () => {
  const saved = process.env.STORE_BACKEND;
  afterEach(() => {
    if (saved === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = saved;
    resetPoolStore();
    resetDatabase();
  });

  test("the default is the file store", () => {
    delete process.env.STORE_BACKEND;
    expect(getPoolStore(LOCAL_TENANT)).toBeInstanceOf(FsPoolStore);
  });

  test("postgres builds a database store per org; a run's scope is its tenant's org", async () => {
    const db = await migratedDatabase();
    await db.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
    setDatabase(db);
    process.env.STORE_BACKEND = "postgres";
    const local = getPoolStore(LOCAL_TENANT);
    expect(local).toBeInstanceOf(PgPoolStore);
    expect(getPoolStore(LOCAL_TENANT)).toBe(local);
    expect(getPoolStore(acme)).not.toBe(local);
    expect(getPoolStore(runEnvironment(LOCAL_TENANT))).toBe(local);
    await local.writePool(pool());
    expect((await getPoolStore(LOCAL_TENANT).readPool("camp"))?.pool.entries).toHaveLength(1);
    await db.end();
  });

  test("a test double set for the registry answers for every tenant until reset", () => {
    const fake = {} as PoolStorePort;
    setPoolStore(fake);
    expect(getPoolStore(LOCAL_TENANT)).toBe(fake);
    expect(getPoolStore(acme)).toBe(fake);
    resetPoolStore();
    expect(getPoolStore(LOCAL_TENANT)).not.toBe(fake);
  });
});
