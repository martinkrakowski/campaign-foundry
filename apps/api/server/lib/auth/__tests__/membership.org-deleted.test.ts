import { describe, test, expect, afterEach } from "vitest";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import type { SqlClient } from "../../db/sql-client.js";
import { memberTenant } from "../membership.js";

type Db = Awaited<ReturnType<typeof migratedDatabase>>;

async function insertUser(db: Db, id: string, email: string) {
  await db.query(
    'insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, $1, $2, true, now(), now())',
    [id, email],
  );
}

async function insertOrg(db: Db, id: string) {
  await db.query(`insert into org (id, name, slug, created_at) values ($1, $1, $1, now())`, [id]);
}

// The ONLY org write this lane makes: the tombstone. Tests only (D241, OD1).
async function tombstoneOrg(db: Db, id: string) {
  await db.query(`update org set deleted_at = now() where id = $1`, [id]);
}

// A memberTenant call is a read; these snapshots prove it touches no row, so a
// second user's untouched org is equal before and after (cross-org isolation).
async function snapshot(db: Db) {
  const members = await db.query<{ id: string; org_id: string; user_id: string; role: string }>(
    `select id, org_id, user_id, role from member order by id`,
  );
  const orgs = await db.query<{ id: string; deleted_at: Date | null }>(
    `select id, deleted_at from org order by id`,
  );
  return { members: members.rows, orgs: orgs.rows };
}

describe("memberTenant and a deleted org (PT-9m1, D241)", () => {
  let db: SqlClient | undefined;
  afterEach(async () => {
    await db?.end();
    db = undefined;
  });

  test("memberTenant answers undefined when the only org of the user is deleted", async () => {
    db = await migratedDatabase();
    await insertUser(db, "u1", "u1@example.com");
    await insertUser(db, "u2", "u2@example.com");
    await insertOrg(db, "alpha");
    await insertOrg(db, "beta");
    await db.query(
      `insert into member (id, org_id, user_id, role, created_at) values ($1, 'alpha', $2, 'owner', now())`,
      ["m1", "u1"],
    );
    await db.query(
      `insert into member (id, org_id, user_id, role, created_at) values ($1, 'beta', $2, 'owner', now())`,
      ["m2", "u2"],
    );
    await tombstoneOrg(db, "alpha");

    const before = await snapshot(db);
    const withoutActive = await memberTenant(db, "u1");
    const withActive = await memberTenant(db, "u1", "alpha");
    const u2Tenant = await memberTenant(db, "u2");
    const after = await snapshot(db);

    expect(withoutActive).toBeUndefined();
    expect(withActive).toBeUndefined();
    expect(u2Tenant?.orgId).toBe("beta");
    expect(before).toEqual(after);
  });

  test("memberTenant skips a deleted active org and answers the first live org by id", async () => {
    db = await migratedDatabase();
    await insertUser(db, "u1", "u1@example.com");
    for (const id of ["alpha", "beta", "gamma"]) await insertOrg(db, id);
    for (const id of ["alpha", "gamma", "beta"]) {
      await db.query(
        `insert into member (id, org_id, user_id, role, created_at) values ($1, $2, $3, 'viewer', now())`,
        [`m-${id}`, id, "u1"],
      );
    }
    await tombstoneOrg(db, "alpha");

    const before = await snapshot(db);
    const tenant = await memberTenant(db, "u1", "alpha");
    const after = await snapshot(db);

    expect(tenant?.orgId).toBe("beta");
    expect(tenant?.roles).toEqual(["viewer"]);
    expect(before).toEqual(after);
  });

  // CONTROL (correction #4): a live active org wins even when another of the
  // user's memberships is deleted. This pins the existing behaviour rather than
  // a deleted-org code path, so it must pass on unchanged source too.
  test("memberTenant keeps a live active org when another membership of the user is deleted", async () => {
    db = await migratedDatabase();
    await insertUser(db, "u1", "u1@example.com");
    for (const id of ["alpha", "beta", "gamma"]) await insertOrg(db, id);
    for (const id of ["alpha", "gamma", "beta"]) {
      await db.query(
        `insert into member (id, org_id, user_id, role, created_at) values ($1, $2, $3, 'viewer', now())`,
        [`m-${id}`, id, "u1"],
      );
    }
    await tombstoneOrg(db, "alpha");

    const before = await snapshot(db);
    const tenant = await memberTenant(db, "u1", "gamma");
    const after = await snapshot(db);

    expect(tenant?.orgId).toBe("gamma");
    expect(before).toEqual(after);
  });

  test("memberTenant reads teams of the live org only and changes no row", async () => {
    db = await migratedDatabase();
    await insertUser(db, "u1", "u1@example.com");
    await insertOrg(db, "alpha");
    await insertOrg(db, "beta");
    await db.query(
      `insert into member (id, org_id, user_id, role, created_at) values ($1, 'alpha', $2, 'owner', now())`,
      ["m1", "u1"],
    );
    await db.query(
      `insert into member (id, org_id, user_id, role, created_at) values ($1, 'beta', $2, 'owner', now())`,
      ["m2", "u1"],
    );
    await db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values ($1, 'Alpha Team', 0, 'alpha', now())`,
      ["team-alpha"],
    );
    await db.query(
      `insert into team (id, name, "memberCount", org_id, created_at) values ($1, 'Beta Team', 0, 'beta', now())`,
      ["team-beta"],
    );
    await db.query(
      'insert into team_member (id, team_id, user_id, "membershipKey", created_at) values ($1, $2, $3, $4, now())',
      ["tm-alpha", "team-alpha", "u1", "alpha:team-alpha:u1"],
    );
    await db.query(
      'insert into team_member (id, team_id, user_id, "membershipKey", created_at) values ($1, $2, $3, $4, now())',
      ["tm-beta", "team-beta", "u1", "beta:team-beta:u1"],
    );
    await tombstoneOrg(db, "alpha");

    const before = await snapshot(db);
    const tenant = await memberTenant(db, "u1", "alpha");
    const after = await snapshot(db);

    expect(tenant?.orgId).toBe("beta");
    expect(tenant?.teamIds).toEqual(["team-beta"]);
    expect(before).toEqual(after);
  });
});
