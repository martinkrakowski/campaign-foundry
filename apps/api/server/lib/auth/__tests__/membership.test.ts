import { describe, test, expect } from "vitest";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { memberTenant } from "../membership.js";

async function insertUser(
  db: Awaited<ReturnType<typeof migratedDatabase>>,
  id: string,
  email: string,
) {
  await db.query(
    'insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, $1, $2, true, now(), now())',
    [id, email],
  );
}

describe("memberTenant (PT-1a item 3)", () => {
  test("undefined when the user has no membership at all", async () => {
    const db = await migratedDatabase();
    await insertUser(db, "u1", "u1@example.com");

    expect(await memberTenant(db, "u1")).toBeUndefined();
  });

  test("a member's tenant carries its org, user, roles and teams", async () => {
    const db = await migratedDatabase();
    await insertUser(db, "u1", "u1@example.com");
    await db.query(
      "insert into member (id, org_id, user_id, role, created_at) values ($1, 'local', $2, 'owner,admin', now())",
      ["m1", "u1"],
    );
    await db.query(
      "insert into team (id, name, \"memberCount\", org_id, created_at) values ($1, 'Creative', 0, 'local', now())",
      ["team1"],
    );
    await db.query(
      'insert into team_member (id, team_id, user_id, "membershipKey", created_at) values ($1, $2, $3, $4, now())',
      ["tm1", "team1", "u1", "local:team1:u1"],
    );

    expect(await memberTenant(db, "u1")).toEqual({
      orgId: "local",
      userId: "u1",
      roles: ["owner", "admin"],
      teamIds: ["team1"],
    });
  });

  test("no teams reads as an empty list, not a missing one", async () => {
    const db = await migratedDatabase();
    await insertUser(db, "u1", "u1@example.com");
    await db.query(
      "insert into member (id, org_id, user_id, role, created_at) values ($1, 'local', $2, 'viewer', now())",
      ["m1", "u1"],
    );

    expect(await memberTenant(db, "u1")).toEqual({
      orgId: "local",
      userId: "u1",
      roles: ["viewer"],
      teamIds: [],
    });
  });

  test("more than one org resolves deterministically, by org id", async () => {
    const db = await migratedDatabase();
    await insertUser(db, "u1", "u1@example.com");
    await db.query(
      "insert into org (id, name, slug, created_at) values ('zeta', 'Zeta', 'zeta', now())",
    );
    await db.query(
      "insert into member (id, org_id, user_id, role, created_at) values ($1, 'zeta', $2, 'owner', now())",
      ["m1", "u1"],
    );
    await db.query(
      "insert into member (id, org_id, user_id, role, created_at) values ($1, 'local', $2, 'owner', now())",
      ["m2", "u1"],
    );

    expect((await memberTenant(db, "u1"))?.orgId).toBe("local");
  });

  describe("activeOrganizationId (PT-1b1 item 2)", () => {
    test("an active org the user belongs to wins", async () => {
      const db = await migratedDatabase();
      await insertUser(db, "u1", "u1@example.com");
      await db.query(
        "insert into org (id, name, slug, created_at) values ('zeta', 'Zeta', 'zeta', now())",
      );
      await db.query(
        "insert into member (id, org_id, user_id, role, created_at) values ($1, 'local', $2, 'viewer', now())",
        ["m1", "u1"],
      );
      await db.query(
        "insert into member (id, org_id, user_id, role, created_at) values ($1, 'zeta', $2, 'owner', now())",
        ["m2", "u1"],
      );
      await db.query(
        "insert into team (id, name, \"memberCount\", org_id, created_at) values ($1, 'Zeta Team', 0, 'zeta', now())",
        ["team-zeta"],
      );
      await db.query(
        'insert into team_member (id, team_id, user_id, "membershipKey", created_at) values ($1, $2, $3, $4, now())',
        ["tm-z", "team-zeta", "u1", "zeta:team-zeta:u1"],
      );

      const tenant = await memberTenant(db, "u1", "zeta");
      expect(tenant).toEqual({
        orgId: "zeta",
        userId: "u1",
        roles: ["owner"],
        teamIds: ["team-zeta"],
      });
    });

    test("a non-member active org falls back", async () => {
      const db = await migratedDatabase();
      await insertUser(db, "u1", "u1@example.com");
      await db.query(
        "insert into org (id, name, slug, created_at) values ('zeta', 'Zeta', 'zeta', now())",
      );
      await db.query(
        "insert into member (id, org_id, user_id, role, created_at) values ($1, 'local', $2, 'viewer', now())",
        ["m1", "u1"],
      );
      await db.query(
        "insert into member (id, org_id, user_id, role, created_at) values ($1, 'zeta', $2, 'owner', now())",
        ["m2", "u1"],
      );

      // User belongs to 'local' and 'zeta', but active org is 'non-member-org'
      const tenant = await memberTenant(db, "u1", "non-member-org");
      expect(tenant?.orgId).toBe("local");
    });

    test("no active org falls back", async () => {
      const db = await migratedDatabase();
      await insertUser(db, "u1", "u1@example.com");
      await db.query(
        "insert into org (id, name, slug, created_at) values ('zeta', 'Zeta', 'zeta', now())",
      );
      await db.query(
        "insert into member (id, org_id, user_id, role, created_at) values ($1, 'local', $2, 'viewer', now())",
        ["m1", "u1"],
      );
      await db.query(
        "insert into member (id, org_id, user_id, role, created_at) values ($1, 'zeta', $2, 'owner', now())",
        ["m2", "u1"],
      );

      expect((await memberTenant(db, "u1", undefined))?.orgId).toBe("local");
      expect((await memberTenant(db, "u1", null))?.orgId).toBe("local");
    });
  });
});
