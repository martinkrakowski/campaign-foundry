import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTH_POOL_MAX, auth, authPool, resetAuth, setAuth, type Auth } from "../instance.js";
import { authOptions } from "../options.js";
import { LogMailer } from "../log-mailer.js";

const KEYS = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "WEB_ORIGIN",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "DATABASE_URL",
  "DATABASE_CA_PATH",
  "DATABASE_POOL_MAX",
] as const;

describe("auth() (PT-1a)", () => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

  beforeEach(async () => {
    await resetAuth();
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(async () => {
    await resetAuth();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("refuses to build without BETTER_AUTH_SECRET", () => {
    expect(() => auth()).toThrow(
      "BETTER_AUTH_SECRET is not set (required when AUTH_MODE=better-auth).",
    );
  });

  test("refuses to build with a BETTER_AUTH_SECRET shorter than 32 characters, naming the setting and never the value", () => {
    process.env.BETTER_AUTH_SECRET = "super-secret-short";
    expect(() => auth()).toThrow("BETTER_AUTH_SECRET must be at least 32 characters long.");
    expect(() => auth()).not.toThrow(/super-secret-short/);
  });

  test("authOptions refuses a secret shorter than 32 characters", () => {
    expect(() =>
      authOptions({
        database: {} as never,
        secret: "short",
        baseURL: "http://127.0.0.1:3001",
        mailer: new LogMailer(),
      }),
    ).toThrow("BETTER_AUTH_SECRET must be at least 32 characters long.");
  });

  test("refuses to build without BETTER_AUTH_URL", () => {
    process.env.BETTER_AUTH_SECRET = "s".repeat(32);
    expect(() => auth()).toThrow(
      "BETTER_AUTH_URL is not set (required when AUTH_MODE=better-auth).",
    );
  });

  test("refuses to build with a RESEND_API_KEY but no EMAIL_FROM", () => {
    process.env.BETTER_AUTH_SECRET = "s".repeat(32);
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";
    process.env.RESEND_API_KEY = "re_test";
    expect(() => auth()).toThrow("EMAIL_FROM is not set (required alongside RESEND_API_KEY).");
  });

  test("builds with a LogMailer when no RESEND_API_KEY is set, and with no Google provider", () => {
    process.env.BETTER_AUTH_SECRET = "s".repeat(32);
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";

    const instance = auth();

    expect(instance.options.socialProviders).toBeUndefined();
  });

  test("builds with a ResendMailer and Google when both settings are complete", () => {
    process.env.BETTER_AUTH_SECRET = "s".repeat(32);
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "noreply@example.com";
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.WEB_ORIGIN = "http://127.0.0.1:3000";

    const instance = auth();

    expect(instance.options.socialProviders?.google).toEqual(
      expect.objectContaining({ clientId: "client-id", clientSecret: "client-secret" }),
    );
    expect(instance.options.trustedOrigins).toEqual(["http://127.0.0.1:3000"]);
  });

  test("Google is not enabled when only one of its two settings is present", () => {
    process.env.BETTER_AUTH_SECRET = "s".repeat(32);
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    process.env.GOOGLE_CLIENT_ID = "client-id";

    expect(auth().options.socialProviders).toBeUndefined();
  });

  test("is built once and cached across calls", () => {
    process.env.BETTER_AUTH_SECRET = "s".repeat(32);
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";

    expect(auth()).toBe(auth());
  });

  test("setAuth installs an instance every caller gets back", () => {
    const fake = { marker: "fake" } as unknown as Auth;
    setAuth(fake);
    expect(auth()).toBe(fake);
  });

  describe("cookie security behind proxy (Finding 2)", () => {
    test("sets useSecureCookies: true when WEB_ORIGIN is https", () => {
      process.env.BETTER_AUTH_SECRET = "s".repeat(32);
      process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
      process.env.WEB_ORIGIN = "https://app.example.com";

      const instance = auth();
      expect(instance.options.advanced?.useSecureCookies).toBe(true);
    });

    test("sets useSecureCookies: false when WEB_ORIGIN is http", () => {
      process.env.BETTER_AUTH_SECRET = "s".repeat(32);
      process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
      process.env.WEB_ORIGIN = "http://localhost:3000";

      const instance = auth();
      expect(instance.options.advanced?.useSecureCookies).toBe(false);
    });

    test("sets useSecureCookies: false when WEB_ORIGIN is absent", () => {
      process.env.BETTER_AUTH_SECRET = "s".repeat(32);
      process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
      delete process.env.WEB_ORIGIN;

      const instance = auth();
      expect(instance.options.advanced?.useSecureCookies).toBe(false);
    });

    test("sets useSecureCookies: false when WEB_ORIGIN is an invalid URL", () => {
      process.env.BETTER_AUTH_SECRET = "s".repeat(32);
      process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
      process.env.WEB_ORIGIN = "not-a-valid-url";

      const instance = auth();
      expect(instance.options.advanced?.useSecureCookies).toBe(false);
    });
  });

  describe("its own pool", () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    test("reads the CA file for a remote DATABASE_URL, same as the CLI's pool", () => {
      dir = mkdtempSync(join(tmpdir(), "cf-auth-ca-"));
      writeFileSync(join(dir, "ca.pem"), "PEM");
      process.env.BETTER_AUTH_SECRET = "s".repeat(32);
      process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";
      process.env.DATABASE_URL = "postgres://user:pass@db.example.com:5432/db";
      process.env.DATABASE_CA_PATH = join(dir, "ca.pem");

      expect(() => auth()).not.toThrow();
    });

    test("is capped at AUTH_POOL_MAX (2), ignoring larger DATABASE_POOL_MAX (Finding 3)", () => {
      process.env.BETTER_AUTH_SECRET = "s".repeat(32);
      process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
      process.env.DATABASE_POOL_MAX = "10";

      auth();
      const p = authPool();
      expect(p).toBeDefined();
      expect(p?.options.max).toBe(AUTH_POOL_MAX);
    });

    test("resetAuth ends the shared pool before discarding it (Finding 6)", async () => {
      process.env.BETTER_AUTH_SECRET = "s".repeat(32);
      process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";

      auth();
      const p = authPool();
      expect(p).toBeDefined();
      const endSpy = vi.spyOn(p!, "end");
      await resetAuth();
      expect(endSpy).toHaveBeenCalled();
      expect(authPool()).toBeUndefined();
    });
  });
});
