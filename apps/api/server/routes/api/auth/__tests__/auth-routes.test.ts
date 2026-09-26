import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import { createApp, createRouter, toWebHandler } from "h3";
import { PGlite } from "@electric-sql/pglite";
import { betterAuth } from "better-auth";
import authHandler from "../[...all].js";
import { setAuth, resetAuth } from "../../../../lib/auth/instance.js";
import { authOptions } from "../../../../lib/auth/options.js";
import { LogMailer } from "../../../../lib/auth/log-mailer.js";
import { pglitePgPool } from "../../../../lib/db/__tests__/pglite-pg-pool.js";
import { loadMigrations, migrate } from "../../../../lib/db/migrate.js";
import { pgClient } from "../../../../lib/db/pg-client.js";

describe("GET /api/auth/** (PT-1a, Finding 1)", () => {
  const savedAuthMode = process.env.AUTH_MODE;

  beforeEach(async () => {
    await resetAuth();
  });

  afterEach(async () => {
    await resetAuth();
    if (savedAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = savedAuthMode;
    vi.restoreAllMocks();
  });

  const makeApp = () => {
    const app = createApp();
    const router = createRouter();
    router.use("/api/auth/**", authHandler);
    app.use(router);
    return toWebHandler(app);
  };

  test("under AUTH_MODE=better-auth, a request to /api/auth/ok reaches Better Auth", async () => {
    process.env.AUTH_MODE = "better-auth";
    const raw = new PGlite();
    const sql = pgClient(
      {
        host: "localhost",
        port: 5432,
        user: "u",
        password: "p",
        database: "d",
        ssl: false,
        max: 1,
      },
      () => pglitePgPool(raw),
    );
    await migrate(sql, await loadMigrations());

    const instance = betterAuth(
      authOptions({
        database: pglitePgPool(raw),
        secret: "a".repeat(32),
        baseURL: "http://127.0.0.1:3000",
        mailer: new LogMailer(),
      }),
    );
    setAuth(instance);

    const handle = makeApp();
    const res = await handle(new Request("http://127.0.0.1:3000/api/auth/ok", { method: "GET" }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("under AUTH_MODE=local, a request to /api/auth/ok answers 404", async () => {
    process.env.AUTH_MODE = "local";
    const handle = makeApp();
    const res = await handle(new Request("http://127.0.0.1:3000/api/auth/ok", { method: "GET" }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });
});
