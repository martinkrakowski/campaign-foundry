import { describe, test, expect, afterEach } from "vitest";
import plugin from "../auth-boot-guard.js";

describe("auth-boot-guard (PT-1a item 4)", () => {
  const savedAuth = process.env.AUTH_MODE;
  const savedStore = process.env.STORE_BACKEND;
  afterEach(() => {
    if (savedAuth === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = savedAuth;
    if (savedStore === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = savedStore;
  });

  test("refuses to boot AUTH_MODE=better-auth without STORE_BACKEND=postgres", () => {
    process.env.AUTH_MODE = "better-auth";
    process.env.STORE_BACKEND = "fs";
    expect(() => plugin({} as never)).toThrow(
      "AUTH_MODE=better-auth requires STORE_BACKEND=postgres: Better Auth's tables (0008_auth) are Postgres-only, and this host would boot authenticated with no store for them.",
    );
  });

  test("boots fine with AUTH_MODE=better-auth and STORE_BACKEND=postgres", () => {
    process.env.AUTH_MODE = "better-auth";
    process.env.STORE_BACKEND = "postgres";
    expect(() => plugin({} as never)).not.toThrow();
  });

  test("boots fine under AUTH_MODE=local regardless of STORE_BACKEND", () => {
    delete process.env.AUTH_MODE;
    process.env.STORE_BACKEND = "fs";
    expect(() => plugin({} as never)).not.toThrow();
  });
});
