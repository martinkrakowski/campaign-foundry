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

describe("tenant middleware (PT-1a item 3)", () => {
  const savedAuthMode = process.env.AUTH_MODE;

  beforeEach(async () => {
    db = await migratedDatabase();
    getSessionMock.mockReset();
  });

  afterEach(() => {
    if (savedAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = savedAuthMode;
  });

  test("is a no-op under AUTH_MODE=local: the protected route runs with no session lookup", async () => {
    delete process.env.AUTH_MODE;
    const res = await testApp()(new Request("http://x/campaigns/briefs"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenant: null });
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  describe("under AUTH_MODE=better-auth", () => {
    beforeEach(() => {
      process.env.AUTH_MODE = "better-auth";
    });

    test.each([
      ["GET", "/"],
      ["GET", "/campaigns/capabilities"],
      ["GET", "/api/auth/session"],
      ["POST", "/api/auth/sign-in/magic-link"],
    ])("allowlists %s %s with no session lookup", async (method, path) => {
      const res = await testApp()(new Request(`http://x${path}`, { method }));
      expect(res.status).toBe(200);
      expect(getSessionMock).not.toHaveBeenCalled();
    });

    test("an unauthenticated request to a protected route is 401", async () => {
      getSessionMock.mockResolvedValue(null);
      const res = await testApp()(new Request("http://x/campaigns/briefs"));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Sign in required.", code: "unauthenticated" });
    });

    test("a session with no membership is 403 no_membership", async () => {
      await insertUser("u1", "u1@example.com");
      getSessionMock.mockResolvedValue({ user: { id: "u1" }, session: {} });
      const res = await testApp()(new Request("http://x/campaigns/briefs"));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "This account belongs to no organisation.",
        code: "no_membership",
      });
    });

    test("a member's request gets event.context.tenant with its org, user, roles and teams", async () => {
      await insertUser("u1", "u1@example.com");
      await db.query(
        "insert into member (id, org_id, user_id, role, created_at) values ($1, 'local', $2, 'owner', now())",
        ["m1", "u1"],
      );
      getSessionMock.mockResolvedValue({ user: { id: "u1" }, session: {} });

      const res = await testApp()(new Request("http://x/campaigns/briefs"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        tenant: { orgId: "local", userId: "u1", roles: ["owner"], teamIds: [] },
      });
    });
  });
});
