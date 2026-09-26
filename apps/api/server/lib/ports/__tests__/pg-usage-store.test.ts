import { describe, test, expect, beforeEach, afterEach } from "vitest";
import type { SqlClient } from "../../db/sql-client.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { PgUsageStore } from "../pg-usage-store.js";
import { FsUsageStore } from "../fs-usage-store.js";
import { getUsageStore, resetUsageStore, setUsageStore } from "../index.js";
import { LOCAL_TENANT } from "../../tenant.js";
import { resetDatabase, setDatabase } from "../../db/database.js";

describe("PgUsageStore (PT-7a, D175)", () => {
  let db: SqlClient;
  beforeEach(async () => {
    db = await migratedDatabase();
    await db.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
  });
  afterEach(async () => {
    await db.end();
  });

  test("a recorded generation reads back with the fields it was given", async () => {
    const store = new PgUsageStore(db);
    await store.record({
      orgId: "local",
      provider: "imagen",
      model: "imagen-4.0-generate-001",
      units: 1,
      keyOwner: "platform",
    });
    const { rows } = await db.query<{
      org_id: string;
      provider: string;
      model: string;
      units: number;
      key_owner: string;
    }>("select org_id, provider, model, units, key_owner from usage where org_id = $1", ["local"]);
    expect(rows).toEqual([
      {
        org_id: "local",
        provider: "imagen",
        model: "imagen-4.0-generate-001",
        units: 1,
        key_owner: "platform",
      },
    ]);
  });

  test("an org with no quota column set reads as unlimited", async () => {
    const store = new PgUsageStore(db);
    await expect(store.quota("local")).resolves.toBeNull();
  });

  test("an org id with no row at all is refused, not unlimited (fix round, reviewer)", async () => {
    // Unlike "local" above (a real row, null column), this org id names no
    // `org` row: `null` from the column and "no row" must not read the same
    // way, or a typo'd or deleted org id would be admitted without limit.
    const store = new PgUsageStore(db);
    await expect(store.quota("ghost")).resolves.toBe(0);
  });

  test("countThisMonth counts this calendar month's rows for the org, in UTC", async () => {
    const store = new PgUsageStore(db);
    const now = new Date("2026-09-24T12:00:00.000Z");
    await store.record({
      orgId: "local",
      provider: "imagen",
      model: "m",
      units: 1,
      keyOwner: "platform",
    });
    await store.record({
      orgId: "local",
      provider: "imagen",
      model: "m",
      units: 1,
      keyOwner: "platform",
    });
    await expect(store.countThisMonth("local", now)).resolves.toBe(2);
  });

  test("a row from last month does not count toward this month's total (the month boundary)", async () => {
    const store = new PgUsageStore(db);
    // One row dated in August, one recorded "now" (September) — the store's own write.
    await db.query(
      `insert into usage (org_id, provider, model, units, key_owner, created_at)
       values ($1, $2, $3, $4, $5, $6)`,
      ["local", "imagen", "m", 1, "platform", "2026-08-31T23:59:59.999Z"],
    );
    await store.record({
      orgId: "local",
      provider: "imagen",
      model: "m",
      units: 1,
      keyOwner: "platform",
    });
    await expect(store.countThisMonth("local", new Date("2026-09-01T00:00:00.000Z"))).resolves.toBe(
      1,
    );
  });

  test("countThisMonth reaches exactly the quota after enough recorded rows, and no further", async () => {
    const store = new PgUsageStore(db);
    await db.query("update org set monthly_generation_quota = $2 where id = $1", ["local", 2]);
    const now = new Date("2026-09-24T12:00:00.000Z");
    const quota = await store.quota("local");
    expect(quota).toBe(2);
    expect(await store.countThisMonth("local", now)).toBe(0); // below quota
    await store.record({
      orgId: "local",
      provider: "imagen",
      model: "m",
      units: 1,
      keyOwner: "platform",
    });
    expect(await store.countThisMonth("local", now)).toBe(1); // still below quota
    await store.record({
      orgId: "local",
      provider: "imagen",
      model: "m",
      units: 1,
      keyOwner: "platform",
    });
    expect(await store.countThisMonth("local", now)).toBe(2); // exactly the quota
  });

  test("usage is isolated per org: one org's rows and quota never leak into another's count", async () => {
    const store = new PgUsageStore(db);
    await db.query("update org set monthly_generation_quota = $2 where id = $1", ["acme", 5]);
    await store.record({
      orgId: "local",
      provider: "imagen",
      model: "m",
      units: 1,
      keyOwner: "platform",
    });
    await store.record({
      orgId: "local",
      provider: "imagen",
      model: "m",
      units: 1,
      keyOwner: "platform",
    });
    await store.record({
      orgId: "acme",
      provider: "imagen",
      model: "m",
      units: 1,
      keyOwner: "platform",
    });
    const now = new Date("2026-09-24T12:00:00.000Z");
    await expect(store.countThisMonth("local", now)).resolves.toBe(2);
    await expect(store.countThisMonth("acme", now)).resolves.toBe(1);
    await expect(store.quota("local")).resolves.toBeNull();
    await expect(store.quota("acme")).resolves.toBe(5);
  });

  test("reserve at quota returns null (PT-7a2, D175)", async () => {
    const store = new PgUsageStore(db);
    await db.query("update org set monthly_generation_quota = 1 where id = $1", ["local"]);
    const id1 = await store.reserve("local");
    expect(id1).toEqual(expect.any(String));
    const id2 = await store.reserve("local");
    expect(id2).toBeNull();
  });

  test("a released reservation frees its slot (PT-7a2, D175)", async () => {
    const store = new PgUsageStore(db);
    await db.query("update org set monthly_generation_quota = 1 where id = $1", ["local"]);
    const id = await store.reserve("local");
    expect(id).toEqual(expect.any(String));
    expect(await store.reserve("local")).toBeNull();
    await store.release(id!);
    const id2 = await store.reserve("local");
    expect(id2).toEqual(expect.any(String));
  });

  test("a reservation older than the TTL no longer counts (PT-7a2, D175)", async () => {
    const store = new PgUsageStore(db);
    await db.query("update org set monthly_generation_quota = 1 where id = $1", ["local"]);
    const id = await store.reserve("local");
    expect(id).toEqual(expect.any(String));
    expect(await store.reserve("local")).toBeNull();
    await db.query("update usage set created_at = now() - interval '2 hours' where id = $1", [id]);
    const id2 = await store.reserve("local");
    expect(id2).toEqual(expect.any(String));
  });

  test("settle turns it into a recorded row with the fields (PT-7a2, D175)", async () => {
    const store = new PgUsageStore(db);
    const id = await store.reserve("local");
    expect(id).toEqual(expect.any(String));
    await store.settle(id!, {
      orgId: "local",
      provider: "imagen",
      model: "imagen-4.0",
      units: 1,
      keyOwner: "platform",
    });
    const { rows } = await db.query<{
      status: string;
      provider: string;
      model: string;
      units: number;
      key_owner: string;
    }>("select status, provider, model, units, key_owner from usage where id = $1", [id]);
    expect(rows).toEqual([
      {
        status: "recorded",
        provider: "imagen",
        model: "imagen-4.0",
        units: 1,
        key_owner: "platform",
      },
    ]);
  });
});

describe("STORE_BACKEND selects the usage adapter (PT-7a)", () => {
  const saved = process.env.STORE_BACKEND;
  afterEach(() => {
    if (saved === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = saved;
    resetUsageStore();
    resetDatabase();
  });

  test("the default is the no-op file store", () => {
    delete process.env.STORE_BACKEND;
    expect(getUsageStore(LOCAL_TENANT)).toBeInstanceOf(FsUsageStore);
  });

  test("postgres builds a database-backed store, shared across every org", async () => {
    const db = await migratedDatabase();
    setDatabase(db);
    process.env.STORE_BACKEND = "postgres";
    const store = getUsageStore(LOCAL_TENANT);
    expect(store).toBeInstanceOf(PgUsageStore);
    const acme = { ...LOCAL_TENANT, orgId: "acme", userId: "u1" };
    expect(getUsageStore(acme)).toBe(store); // one store, not per-org (methods take orgId)
    await db.end();
  });

  test("a double set for the registry answers for every scope until reset", () => {
    const fake = new FsUsageStore();
    setUsageStore(fake);
    expect(getUsageStore(LOCAL_TENANT)).toBe(fake);
    resetUsageStore();
    expect(getUsageStore(LOCAL_TENANT)).not.toBe(fake);
  });
});
