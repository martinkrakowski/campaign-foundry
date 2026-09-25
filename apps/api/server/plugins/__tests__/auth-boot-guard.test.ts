import { describe, test, expect, afterEach, vi } from "vitest";
import plugin from "../auth-boot-guard.js";

const KEYS = [
  "AUTH_MODE",
  "STORE_BACKEND",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "WEB_ORIGIN",
  "RESEND_API_KEY",
  "EMAIL_FROM",
] as const;

function setValidBetterAuthEnv() {
  process.env.AUTH_MODE = "better-auth";
  process.env.STORE_BACKEND = "postgres";
  process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
  process.env.BETTER_AUTH_SECRET = "s".repeat(32);
  process.env.WEB_ORIGIN = "http://127.0.0.1:3000";
}

describe("auth-boot-guard (PT-1a item 4, Finding 4)", () => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  test("refuses to boot AUTH_MODE=better-auth without STORE_BACKEND=postgres", () => {
    setValidBetterAuthEnv();
    process.env.STORE_BACKEND = "fs";
    expect(() => plugin({} as never)).toThrow(
      "AUTH_MODE=better-auth requires STORE_BACKEND=postgres: Better Auth's tables (0008_auth) are Postgres-only, and this host would boot authenticated with no store for them.",
    );
  });

  test("refuses to boot AUTH_MODE=better-auth without DATABASE_URL", () => {
    setValidBetterAuthEnv();
    delete process.env.DATABASE_URL;
    expect(() => plugin({} as never)).toThrow(
      "DATABASE_URL is not set (required when AUTH_MODE=better-auth).",
    );
  });

  test("refuses to boot AUTH_MODE=better-auth without BETTER_AUTH_SECRET", () => {
    setValidBetterAuthEnv();
    delete process.env.BETTER_AUTH_SECRET;
    expect(() => plugin({} as never)).toThrow(
      "BETTER_AUTH_SECRET is not set (required when AUTH_MODE=better-auth).",
    );
  });

  test("refuses to boot AUTH_MODE=better-auth with secret shorter than 32 characters", () => {
    setValidBetterAuthEnv();
    process.env.BETTER_AUTH_SECRET = "too-short-secret";
    expect(() => plugin({} as never)).toThrow(
      "BETTER_AUTH_SECRET must be at least 32 characters long.",
    );
  });

  test("refuses to boot AUTH_MODE=better-auth without WEB_ORIGIN", () => {
    setValidBetterAuthEnv();
    delete process.env.WEB_ORIGIN;
    expect(() => plugin({} as never)).toThrow(
      "WEB_ORIGIN is not set (required when AUTH_MODE=better-auth).",
    );
  });

  test("refuses to boot AUTH_MODE=better-auth with an invalid WEB_ORIGIN URL", () => {
    setValidBetterAuthEnv();
    process.env.WEB_ORIGIN = "not-a-valid-url";
    expect(() => plugin({} as never)).toThrow(
      'WEB_ORIGIN must be a valid http or https URL, not "not-a-valid-url".',
    );
  });

  test("refuses to boot AUTH_MODE=better-auth with RESEND_API_KEY but no EMAIL_FROM", () => {
    setValidBetterAuthEnv();
    process.env.RESEND_API_KEY = "re_test_key";
    delete process.env.EMAIL_FROM;
    expect(() => plugin({} as never)).toThrow(
      "EMAIL_FROM is not set (required alongside RESEND_API_KEY).",
    );
  });

  test("boots fine with AUTH_MODE=better-auth and STORE_BACKEND=postgres, warning when RESEND_API_KEY is not set", () => {
    setValidBetterAuthEnv();
    delete process.env.RESEND_API_KEY;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => plugin({} as never)).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/RESEND_API_KEY is not set.*LogMailer.*not sent/),
    );
  });

  test("boots fine without warning when RESEND_API_KEY and EMAIL_FROM are set", () => {
    setValidBetterAuthEnv();
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM = "noreply@example.com";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => plugin({} as never)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("boots fine under AUTH_MODE=local regardless of STORE_BACKEND and without warning or auth settings", () => {
    delete process.env.AUTH_MODE;
    process.env.STORE_BACKEND = "fs";
    delete process.env.RESEND_API_KEY;
    delete process.env.DATABASE_URL;
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.WEB_ORIGIN;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => plugin({} as never)).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
