import { describe, test, expect, afterEach, vi } from "vitest";
import plugin from "../auth-boot-guard.js";

describe("auth-boot-guard (PT-1a item 4, Finding 4)", () => {
  const savedAuth = process.env.AUTH_MODE;
  const savedStore = process.env.STORE_BACKEND;
  const savedResend = process.env.RESEND_API_KEY;
  afterEach(() => {
    if (savedAuth === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = savedAuth;
    if (savedStore === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = savedStore;
    if (savedResend === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = savedResend;
    vi.restoreAllMocks();
  });

  test("refuses to boot AUTH_MODE=better-auth without STORE_BACKEND=postgres", () => {
    process.env.AUTH_MODE = "better-auth";
    process.env.STORE_BACKEND = "fs";
    expect(() => plugin({} as never)).toThrow(
      "AUTH_MODE=better-auth requires STORE_BACKEND=postgres: Better Auth's tables (0008_auth) are Postgres-only, and this host would boot authenticated with no store for them.",
    );
  });

  test("boots fine with AUTH_MODE=better-auth and STORE_BACKEND=postgres, warning when RESEND_API_KEY is not set", () => {
    process.env.AUTH_MODE = "better-auth";
    process.env.STORE_BACKEND = "postgres";
    delete process.env.RESEND_API_KEY;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => plugin({} as never)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/RESEND_API_KEY is not set.*LogMailer.*not sent/),
    );
  });

  test("boots fine without warning when RESEND_API_KEY is set", () => {
    process.env.AUTH_MODE = "better-auth";
    process.env.STORE_BACKEND = "postgres";
    process.env.RESEND_API_KEY = "re_test_key";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => plugin({} as never)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("boots fine under AUTH_MODE=local regardless of STORE_BACKEND and without warning", () => {
    delete process.env.AUTH_MODE;
    process.env.STORE_BACKEND = "fs";
    delete process.env.RESEND_API_KEY;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => plugin({} as never)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
