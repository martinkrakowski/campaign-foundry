import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp, createRouter, toWebHandler } from "h3";
import { migratedDatabase } from "../../lib/db/__tests__/pglite-client.js";

const getSessionMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/auth/instance.js", () => ({
  auth: () => ({ api: { getSession: getSessionMock } }),
}));

let db: Awaited<ReturnType<typeof migratedDatabase>>;
vi.mock("../../lib/db/database.js", () => ({ database: () => db }));

const { default: tenantMiddleware } = await import("../tenant.js");

/** A protected route, plus the three allowlisted ones, behind the real middleware. */
function testApp() {
  const app = createApp();
  app.use(tenantMiddleware);
  const router = createRouter();
  router.get(
    "/",
    defineEventHandler(() => ({ status: "ok" })),
  );
  router.get(
    "/campaigns/capabilities",
    defineEventHandler(() => ({ motion: false })),
  );
  router.get(
    "/api/auth/session",
    defineEventHandler(() => ({ handledBy: "better-auth" })),
  );
  router.post(
    "/api/auth/sign-in/magic-link",
    defineEventHandler(() => ({ handledBy: "better-auth" })),
  );
  router.get(
    "/campaigns/briefs",
    defineEventHandler((event) => ({ tenant: event.context.tenant ?? null })),
  );
  app.use(router);
  return toWebHandler(app);
}

async function insertUser(id: string, email: string) {
  await db.query(
    'insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, $1, $2, true, now(), now())',
    [id, email],
  );
}

async function insertOrg(id: string) {
  await db.query(`insert into org (id, name, slug, created_at) values ($1, $1, $1, now())`, [id]);
}

// The ONLY org write this lane makes: the tombstone. Tests only (D241, OD1).
async function tombstoneOrg(id: string) {
  await db.query(`update org set deleted_at = now() where id = $1`, [id]);
}

// The request is a read; prove it changes no row so a second org's data is
// equal before and after (cross-org isolation).
async function snapshot() {
  const members = await db.query<{ id: string; org_id: string; user_id: string; role: string }>(
    `select id, org_id, user_id, role from member order by id`,
  );
  const orgs = await db.query<{ id: string; deleted_at: Date | null }>(
    `select id, deleted_at from org order by id`,
  );
  return { members: members.rows, orgs: orgs.rows };
}

describe("tenant middleware and a deleted org (PT-9m1, D241)", () => {
  const savedAuthMode = process.env.AUTH_MODE;

  beforeEach(async () => {
    db = await migratedDatabase();
    getSessionMock.mockReset();
    process.env.AUTH_MODE = "better-auth";
  });

  afterEach(async () => {
    // Closes the database beforeEach opened and restores the auth mode, so a
    // deleted-org test cannot leak its AUTH_MODE into another file.
    await db.end();
    if (savedAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = savedAuthMode;
  });

  test("a member of a deleted org is 403 no_membership and the route never runs", async () => {
    await insertUser("u1", "u1@example.com");
    await insertOrg("alpha");
    await db.query(
      `insert into member (id, org_id, user_id, role, created_at) values ($1, 'alpha', $2, 'owner', now())`,
      ["m1", "u1"],
    );
    await tombstoneOrg("alpha");

    getSessionMock.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "alpha" },
    });

    const res = await testApp()(new Request("http://x/campaigns/briefs"));
    expect(res.status).toBe(403);
    // The protected handler would answer `{ tenant: null }`; this body proves the
    // route never ran — memberTenant found no tenant and the middleware short
    // circuited with the same no-membership shape the live code already uses.
    expect(await res.json()).toEqual({
      error: "This account belongs to no organisation.",
      code: "no_membership",
    });
  });

  test("a member of a deleted org who also belongs to a live org gets the live tenant", async () => {
    await insertUser("u1", "u1@example.com");
    await insertOrg("alpha");
    await insertOrg("beta");
    await db.query(
      `insert into member (id, org_id, user_id, role, created_at) values ($1, 'alpha', $2, 'owner', now())`,
      ["m1", "u1"],
    );
    await db.query(
      `insert into member (id, org_id, user_id, role, created_at) values ($1, 'beta', $2, 'admin', now())`,
      ["m2", "u1"],
    );
    await tombstoneOrg("alpha");

    getSessionMock.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "alpha" },
    });

    const res = await testApp()(new Request("http://x/campaigns/briefs"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tenant: { orgId: "beta", userId: "u1", roles: ["admin"], teamIds: [] },
    });
  });

  // CONTROL (correction #4): a live org is unaffected by another org's
  // tombstone. Not a mutation witness; pins that existing behaviour.
  test("a member of a live org is unaffected while another org is deleted", async () => {
    await insertUser("u2", "u2@example.com");
    await insertOrg("gamma");
    await insertOrg("alpha");
    await db.query(
      `insert into member (id, org_id, user_id, role, created_at) values ($1, 'gamma', $2, 'owner', now())`,
      ["m2", "u2"],
    );
    await tombstoneOrg("alpha");

    const before = await snapshot();
    getSessionMock.mockResolvedValue({
      user: { id: "u2" },
      session: { activeOrganizationId: "gamma" },
    });

    const res = await testApp()(new Request("http://x/campaigns/briefs"));

    const after = await snapshot();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      tenant: { orgId: "gamma", userId: "u2", roles: ["owner"], teamIds: [] },
    });
    expect(before).toEqual(after);
  });
});
