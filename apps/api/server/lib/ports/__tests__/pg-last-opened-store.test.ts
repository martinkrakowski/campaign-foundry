import { describe, test, expect, afterEach, beforeEach } from "vitest";
import type { SqlClient } from "../../db/sql-client.js";
import { resetDatabase, setDatabase } from "../../db/database.js";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { LOCAL_TENANT } from "../../tenant.js";
import { PgBriefStore } from "../pg-brief-store.js";
import { PgLastOpenedStore } from "../pg-last-opened-store.js";
import { FsLastOpenedStore } from "../fs-last-opened-store.js";
import {
  getLastOpenedStore,
  resetLastOpenedStore,
  setLastOpenedStore,
  type LastOpenedStorePort,
} from "../index.js";

/** Mint a campaign row through the real port, the same way every caller does. */
async function mintCampaign(db: SqlClient, orgId: string, slug: string): Promise<string> {
  const { campaignId } = await new PgBriefStore(db, orgId, "local").createCampaign(slug);
  return campaignId;
}

describe("PgLastOpenedStore (PT-5e, D173, D180)", () => {
  let db: SqlClient;
  beforeEach(async () => {
    db = await migratedDatabase();
  });
  afterEach(async () => {
    await db.end();
  });

  test("a user who has opened nothing reads as undefined", async () => {
    const store = new PgLastOpenedStore(db, "local");
    await expect(store.read("u1")).resolves.toBeUndefined();
  });

  test("a pointer round-trips its campaign and its own clock as an ISO-8601 UTC instant", async () => {
    const campaignId = await mintCampaign(db, "local", "camp");
    const store = new PgLastOpenedStore(db, "local");
    const written = await store.write(campaignId, "u1");
    expect(written.campaignId).toBe(campaignId);
    // The store's own clock, rendered the same ISO shape every port answers
    // (`PgDecisionStore`'s `to_char`) — never a JS `Date` leaking out.
    expect(written.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    await expect(store.read("u1")).resolves.toEqual(written);
  });

  test("opening a second campaign replaces the pointer in place, not a second row", async () => {
    const first = await mintCampaign(db, "local", "first");
    const second = await mintCampaign(db, "local", "second");
    const store = new PgLastOpenedStore(db, "local");
    await store.write(first, "u1");
    const moved = await store.write(second, "u1");
    expect(moved.campaignId).toBe(second);
    await expect(store.read("u1")).resolves.toEqual(moved);
    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from last_opened where org_id = $1 and user_id = $2",
      ["local", "u1"],
    );
    expect(rows[0]!.count).toBe("1");
  });

  // The mutation this lane records: dropping the `user_id` filter from `read`
  // would hand two users in one org each other's last-opened campaign.
  test("two users in one org keep independent pointers", async () => {
    const mine = await mintCampaign(db, "local", "mine");
    const theirs = await mintCampaign(db, "local", "theirs");
    const store = new PgLastOpenedStore(db, "local");
    await store.write(mine, "u1");
    await store.write(theirs, "u2");
    expect((await store.read("u1"))?.campaignId).toBe(mine);
    expect((await store.read("u2"))?.campaignId).toBe(theirs);
  });

  test('a pointer PUT succeeds under local auth, with no `"user"` row at all (PT-5d\'s dropped FK)', async () => {
    // `LOCAL_TENANT.userId` is `"local"` under `AUTH_MODE=local` and no
    // migration seeds a `"user"` row for it — the reason `user_id` is plain
    // `text` here as it is in `0014_draft.sql`. This is the write that a FK
    // would refuse with a 500 the web silently swallows.
    const campaignId = await mintCampaign(db, "local", "camp");
    const store = new PgLastOpenedStore(db, "local");
    await expect(store.write(campaignId, "local")).resolves.toMatchObject({ campaignId });
    await expect(store.read("local")).resolves.toMatchObject({ campaignId });
    const { rows } = await db.query<{ count: string }>(
      'select count(*)::text as count from "user" where id = $1',
      ["local"],
    );
    expect(rows[0]!.count).toBe("0");
  });

  test("another org's pointer is invisible", async () => {
    await db.query("insert into org (id, name) values ($1, $2)", ["acme", "Acme"]);
    const campaignId = await mintCampaign(db, "local", "camp");
    const local = new PgLastOpenedStore(db, "local");
    const acme = new PgLastOpenedStore(db, "acme");
    await local.write(campaignId, "u1");
    // acme's store never sees local's row: the org filter is what hides it, not
    // a coincidence of the pointer being absent.
    await expect(acme.read("u1")).resolves.toBeUndefined();
    // …and writing through acme's own store leaves local's pointer alone.
    await acme.write(campaignId, "u1");
    expect((await local.read("u1"))?.campaignId).toBe(campaignId);
  });

  test("deleting the campaign takes the pointer with it (the FK cascades)", async () => {
    const campaignId = await mintCampaign(db, "local", "camp");
    const store = new PgLastOpenedStore(db, "local");
    await store.write(campaignId, "u1");
    await db.query("delete from campaign where id = $1", [campaignId]);
    await expect(store.read("u1")).resolves.toBeUndefined();
  });
});

describe("STORE_BACKEND=postgres puts the last-opened pointer in the database, one store per org (PT-5e)", () => {
  const saved = process.env.STORE_BACKEND;
  const savedRoot = process.env.PROJECT_ROOT;

  afterEach(() => {
    if (saved === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = saved;
    if (savedRoot === undefined) delete process.env.PROJECT_ROOT;
    else process.env.PROJECT_ROOT = savedRoot;
    resetLastOpenedStore();
    resetDatabase();
  });

  test("the default is the file store, rooted outside briefs/", () => {
    delete process.env.STORE_BACKEND;
    process.env.PROJECT_ROOT = "/tmp/pt-5e-registry";
    expect(getLastOpenedStore(LOCAL_TENANT)).toBeInstanceOf(FsLastOpenedStore);
  });

  test("postgres builds a database store per org, and a test double overrides it", async () => {
    const db = await migratedDatabase();
    setDatabase(db);
    process.env.STORE_BACKEND = "postgres";
    process.env.PROJECT_ROOT = "/tmp/pt-5e-registry";

    const local = getLastOpenedStore(LOCAL_TENANT);
    expect(local).toBeInstanceOf(PgLastOpenedStore);
    expect(getLastOpenedStore(LOCAL_TENANT)).toBe(local);
    // One store per org, exactly like decisions and drafts: the pointer is
    // org-scoped by construction, never by a filter its callers must remember.
    const acme = getLastOpenedStore({ ...LOCAL_TENANT, orgId: "acme" });
    expect(acme).not.toBe(local);

    const fake = {} as LastOpenedStorePort;
    setLastOpenedStore(fake);
    expect(getLastOpenedStore(LOCAL_TENANT)).toBe(fake);
    // `reset` drops the double AND the per-root cache, so the next call builds
    // a fresh adapter rather than handing back the one the double displaced.
    resetLastOpenedStore();
    const rebuilt = getLastOpenedStore(LOCAL_TENANT);
    expect(rebuilt).toBeInstanceOf(PgLastOpenedStore);
    expect(rebuilt).not.toBe(local);

    await db.end();
  });
});
