import { describe, test, expect, afterEach } from "vitest";
import { createApp, createRouter, toWebHandler, type EventHandler } from "h3";
import { LOCAL_TENANT, requestTenant, type TenantContext } from "../tenant.js";

const MEMBER: TenantContext = { orgId: "acme", userId: "u1", roles: ["owner"], teamIds: ["t1"] };

/** Mount `handler` at `GET /`, optionally behind a middleware that sets `event.context.tenant`. */
function mount(handler: EventHandler, setTenant?: TenantContext) {
  const app = createApp();
  if (setTenant) {
    app.use(
      defineEventHandler((event) => {
        event.context.tenant = setTenant;
      }),
    );
  }
  const router = createRouter();
  router.get("/", handler);
  app.use(router);
  return toWebHandler(app);
}

describe("requestTenant (PT-1a item 2)", () => {
  const saved = process.env.AUTH_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = saved;
  });

  const handler = defineEventHandler((event) => ({ tenant: requestTenant(event) }));

  test("under local with no middleware, falls back to LOCAL_TENANT (route tests keep passing unchanged)", async () => {
    delete process.env.AUTH_MODE;
    const res = await mount(handler)(new Request("http://x/"));
    expect(await res.json()).toEqual({ tenant: LOCAL_TENANT });
  });

  test("under local, still honours a tenant a middleware already set", async () => {
    process.env.AUTH_MODE = "local";
    const res = await mount(handler, MEMBER)(new Request("http://x/"));
    expect(await res.json()).toEqual({ tenant: MEMBER });
  });

  test("under better-auth, returns the tenant the middleware set", async () => {
    process.env.AUTH_MODE = "better-auth";
    const res = await mount(handler, MEMBER)(new Request("http://x/"));
    expect(await res.json()).toEqual({ tenant: MEMBER });
  });

  test("under better-auth, throws when no middleware set a tenant (a wiring bug, not a request to serve)", async () => {
    process.env.AUTH_MODE = "better-auth";
    const res = await mount(handler)(new Request("http://x/"));
    expect(res.status).toBe(500);
  });
});
