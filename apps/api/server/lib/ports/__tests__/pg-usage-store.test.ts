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

  test("reserve for a non-existent org returns null (missing org means quota 0)", async () => {
    const store = new PgUsageStore(db);
    await expect(store.reserve("ghost")).resolves.toBeNull();
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

  test("release of a recorded row's id leaves it in place", async () => {
    const store = new PgUsageStore(db);
    await store.record({
      orgId: "local",
      provider: "imagen",
      model: "imagen-4.0",
      units: 1,
      keyOwner: "platform",
    });
    const { rows: before } = await db.query<{ id: string }>(
      "select id from usage where org_id = 'local' and status = 'recorded'",
    );
    expect(before).toHaveLength(1);
    const recordedId = String(before[0].id);

    await store.release(recordedId);

    const { rows: after } = await db.query<{ id: string }>("select id from usage where id = $1", [
      recordedId,
    ]);
    expect(after).toHaveLength(1);
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

  test("settle of a live reservation updates it", async () => {
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

  test("settle of an unknown id inserts a recorded row", async () => {
    const store = new PgUsageStore(db);
    await store.settle("999999", {
      orgId: "local",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      units: 1,
      keyOwner: "platform",
    });
    const { rows } = await db.query<{
      status: string;
      provider: string;
      model: string;
      units: number;
      key_owner: string;
    }>(
      "select status, provider, model, units, key_owner from usage where org_id = 'local' and provider = 'openrouter'",
    );
    expect(rows).toEqual([
      {
        status: "recorded",
        provider: "openrouter",
        model: "google/gemini-2.5-flash",
        units: 1,
        key_owner: "platform",
      },
    ]);
  });

  test("settle cannot touch another org's row", async () => {
    const store = new PgUsageStore(db);
    const acmeReservationId = await store.reserve("acme");
    expect(acmeReservationId).toEqual(expect.any(String));

    // local attempts to settle acme's reservation id
    await store.settle(acmeReservationId!, {
      orgId: "local",
      provider: "imagen",
      model: "imagen-4.0",
      units: 1,
      keyOwner: "platform",
    });

    // Acme's reservation remains untouched in 'reserved' status
    const { rows: acmeRows } = await db.query<{ status: string; org_id: string }>(
      "select status, org_id from usage where id = $1",
      [acmeReservationId],
    );
    expect(acmeRows).toEqual([{ status: "reserved", org_id: "acme" }]);

    // A recorded row was inserted for local instead
    const { rows: localRows } = await db.query<{ status: string; provider: string }>(
      "select status, provider from usage where org_id = 'local' and status = 'recorded'",
    );
    expect(localRows).toHaveLength(1);
    expect(localRows[0]).toEqual({ status: "recorded", provider: "imagen" });
  });

  test("countThisMonth: a live reservation counts, a reservation older than RESERVATION_TTL_MS does not, and a recorded row from last month does not", async () => {
    const store = new PgUsageStore(db);
    const now = new Date("2026-09-24T12:00:00.000Z");

    // 1. A live reservation (30 mins old, within TTL)
    await db.query(
      `insert into usage (org_id, status, created_at)
       values ($1, 'reserved', $2)`,
      ["local", new Date(now.getTime() - 30 * 60 * 1000).toISOString()],
    );

    // 2. An expired reservation older than RESERVATION_TTL_MS (2 hours old)
    await db.query(
      `insert into usage (org_id, status, created_at)
       values ($1, 'reserved', $2)`,
      ["local", new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString()],
    );

    // 3. A recorded row from last month (August)
    await db.query(
      `insert into usage (org_id, provider, model, units, key_owner, status, created_at)
       values ($1, 'imagen', 'm', 1, 'platform', 'recorded', $2)`,
      ["local", "2026-08-31T23:59:59.999Z"],
    );

    // Only the single live reservation should be counted
    await expect(store.countThisMonth("local", now)).resolves.toBe(1);
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
