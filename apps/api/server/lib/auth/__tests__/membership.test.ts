import { describe, test, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import { migratedDatabase } from "../../db/__tests__/pglite-client.js";
import { loadMigrations, migrate } from "../../db/migrate.js";
import { pgClient } from "../../db/pg-client.js";
import { pglitePgPool } from "../../db/__tests__/pglite-pg-pool.js";
import { authOptions } from "../options.js";
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

    test("an existing org the user is not a member of cannot be made active", async () => {
      const db = await migratedDatabase();
      await insertUser(db, "u1", "u1@example.com");
      await insertUser(db, "u2", "u2@example.com");
      await db.query(
        "insert into org (id, name, slug, created_at) values ('beta', 'Beta', 'beta', now())",
      );
      await db.query(
        "insert into member (id, org_id, user_id, role, created_at) values ($1, 'local', $2, 'viewer', now())",
        ["m1", "u1"],
      );
      await db.query(
        "insert into member (id, org_id, user_id, role, created_at) values ($1, 'beta', $2, 'owner', now())",
        ["m2", "u2"],
      );

      const tenant = await memberTenant(db, "u1", "beta");
      expect(tenant?.orgId).toBe("local");
      expect(tenant?.roles).toEqual(["viewer"]);
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

    test("proves Better Auth session carries activeOrganizationId against PGlite", async () => {
      const raw = new PGlite();
      const sql = pgClient(
        {
          host: "localhost",
          port: 5432,
          user: "test",
          password: "test",
          database: "test",
          ssl: false,
          max: 1,
        },
        () => pglitePgPool(raw),
      );
      await migrate(sql, await loadMigrations());

      let magicUrl = "";
      const mailer = {
        send: async (mail: { html: string }) => {
          const match = mail.html.match(/href="([^"]+)"/);
          if (match) magicUrl = match[1]!;
        },
      };

      const instance = betterAuth(
        authOptions({
          database: pglitePgPool(raw),
          secret: "a".repeat(32),
          baseURL: "http://127.0.0.1:3001",
          mailer,
        }),
      );

      await instance.api.signInMagicLink({
        body: { email: "person@example.com" },
        headers: new Headers(),
      });

      const parsedUrl = new URL(magicUrl);
      const token = parsedUrl.searchParams.get("token")!;

      const verifyRes = await instance.api.magicLinkVerify({
        query: { token },
        headers: new Headers(),
        asResponse: true,
      });
      const cookie = verifyRes.headers.get("set-cookie")!;

      // Retrieve user from database
      const userRows = await sql.query<{ id: string }>('select id from "user" where email = $1', [
        "person@example.com",
      ]);
      const userId = userRows.rows[0]!.id;

      // Seed organizations and memberships
      await sql.query(
        "insert into org (id, name, slug, created_at) values ('zeta', 'Zeta', 'zeta', now())",
      );
      await sql.query(
        "insert into member (id, org_id, user_id, role, created_at) values ($1, 'local', $2, 'viewer', now())",
        ["m-local", userId],
      );
      await sql.query(
        "insert into member (id, org_id, user_id, role, created_at) values ($1, 'zeta', $2, 'owner', now())",
        ["m-zeta", userId],
      );

      // Set activeOrganizationId on the session in the database
      await sql.query("update session set \"activeOrganizationId\" = 'zeta'");

      // Call Better Auth getSession
      const session = await instance.api.getSession({
        headers: new Headers({ cookie }),
      });

      expect(session).not.toBeNull();
      const activeOrgId = (session?.session as { activeOrganizationId?: string | null } | undefined)
        ?.activeOrganizationId;
      expect(activeOrgId).toBe("zeta");

      // Verify memberTenant picks the active org
      const tenant = await memberTenant(sql, session!.user.id, activeOrgId);
      expect(tenant?.orgId).toBe("zeta");
      expect(tenant?.roles).toEqual(["owner"]);

      await sql.end();
    });
  });
});
