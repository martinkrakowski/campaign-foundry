import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
import { authMode, authSettings, databaseSettings, outputRoot, storeBackend } from "../config.js";

describe("outputRoot", () => {
  const orig = process.env.OUTPUT_DIR;
  afterEach(() => {
    if (orig === undefined) delete process.env.OUTPUT_DIR;
    else process.env.OUTPUT_DIR = orig;
  });

  test("defaults to <root>/output", () => {
    delete process.env.OUTPUT_DIR;
    expect(outputRoot()).toBe(resolve(projectRoot(), "output"));
  });

  test("honours an absolute OUTPUT_DIR", () => {
    process.env.OUTPUT_DIR = "/tmp/cf-out";
    expect(outputRoot()).toBe("/tmp/cf-out");
  });

  test("resolves a relative OUTPUT_DIR against the project root", () => {
    process.env.OUTPUT_DIR = "custom-out";
    expect(outputRoot()).toBe(resolve(projectRoot(), "custom-out"));
  });
});

describe("databaseSettings (D174a)", () => {
  const keys = ["DATABASE_URL", "DATABASE_CA_PATH", "DATABASE_POOL_MAX"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("reads the three database variables, raw", () => {
    process.env.DATABASE_URL = "postgres://me@localhost/cf";
    process.env.DATABASE_CA_PATH = "certs/ca.pem";
    process.env.DATABASE_POOL_MAX = "3";
    expect(databaseSettings()).toEqual({
      url: "postgres://me@localhost/cf",
      caPath: "certs/ca.pem",
      poolMax: "3",
    });
  });
});

describe("storeBackend (PT-3)", () => {
  const saved = process.env.STORE_BACKEND;
  afterEach(() => {
    if (saved === undefined) delete process.env.STORE_BACKEND;
    else process.env.STORE_BACKEND = saved;
  });

  test("is fs unless STORE_BACKEND says postgres, and refuses anything else", () => {
    delete process.env.STORE_BACKEND;
    expect(storeBackend()).toBe("fs");
    for (const value of ["", "fs"]) {
      process.env.STORE_BACKEND = value;
      expect(storeBackend()).toBe("fs");
    }
    process.env.STORE_BACKEND = "postgres";
    expect(storeBackend()).toBe("postgres");
    process.env.STORE_BACKEND = "mysql";
    expect(() => storeBackend()).toThrow('STORE_BACKEND must be "fs" or "postgres", not "mysql".');
  });
});

describe("the database settings are read after the env files load (PT-3)", () => {
  let dir: string;
  let snapshot: NodeJS.ProcessEnv;
  const origCwd = process.cwd();
  beforeEach(() => {
    snapshot = { ...process.env };
    dir = mkdtempSync(join(tmpdir(), "cf-config-env-"));
    process.env.PROJECT_ROOT = dir;
    process.chdir(dir);
    for (const k of ["STORE_BACKEND", "DATABASE_URL", "DATABASE_CA_PATH", "DATABASE_POOL_MAX"]) {
      delete process.env[k];
    }
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in snapshot)) delete process.env[k];
    for (const k of Object.keys(snapshot)) process.env[k] = snapshot[k] as string;
    vi.restoreAllMocks();
  });

  test("a STORE_BACKEND and DATABASE_URL only in .env.local are seen on the first call", async () => {
    writeFileSync(
      join(dir, ".env.local"),
      "STORE_BACKEND=postgres\nDATABASE_URL=postgres://me@localhost/cf\n",
    );
    vi.resetModules();
    const fresh = await import("../config.js");
    expect(fresh.storeBackend()).toBe("postgres");
    expect(fresh.databaseSettings().url).toBe("postgres://me@localhost/cf");
  });
});

describe("authMode (PT-1a)", () => {
  const saved = process.env.AUTH_MODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = saved;
  });

  test("is local unless AUTH_MODE says better-auth, and refuses anything else", () => {
    delete process.env.AUTH_MODE;
    expect(authMode()).toBe("local");
    for (const value of ["", "local"]) {
      process.env.AUTH_MODE = value;
      expect(authMode()).toBe("local");
    }
    process.env.AUTH_MODE = "better-auth";
    expect(authMode()).toBe("better-auth");
    process.env.AUTH_MODE = "oauth2-proxy";
    expect(() => authMode()).toThrow('AUTH_MODE must be "local" or "better-auth", not "oauth2-proxy".');
  });
});

describe("authSettings (PT-1a item 1)", () => {
  const keys = [
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "WEB_ORIGIN",
    "RESEND_API_KEY",
    "EMAIL_FROM",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
  ] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("reads every setting, raw, and is empty when none are set", () => {
    for (const k of keys) delete process.env[k];
    expect(authSettings()).toEqual({
      secret: undefined,
      baseURL: undefined,
      webOrigin: undefined,
      resendApiKey: undefined,
      emailFrom: undefined,
      googleClientId: undefined,
      googleClientSecret: undefined,
    });

    process.env.BETTER_AUTH_SECRET = "s".repeat(32);
    process.env.BETTER_AUTH_URL = "http://127.0.0.1:3001";
    process.env.WEB_ORIGIN = "http://127.0.0.1:3000";
    process.env.RESEND_API_KEY = "re_test";
    process.env.EMAIL_FROM = "noreply@example.com";
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    expect(authSettings()).toEqual({
      secret: "s".repeat(32),
      baseURL: "http://127.0.0.1:3001",
      webOrigin: "http://127.0.0.1:3000",
      resendApiKey: "re_test",
      emailFrom: "noreply@example.com",
      googleClientId: "client-id",
      googleClientSecret: "client-secret",
    });
  });
});
