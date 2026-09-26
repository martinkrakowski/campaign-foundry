import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
import {
  authMode,
  authSettings,
  databaseSettings,
  keyEncryptionSettings,
  outputRoot,
  storeBackend,
} from "../config.js";

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
    expect(() => authMode()).toThrow(
      'AUTH_MODE must be "local" or "better-auth", not "oauth2-proxy".',
    );
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

describe("keyEncryptionSettings (PT-7b1)", () => {
  const keys = ["KEY_ENCRYPTION_KEYS", "KEY_ENCRYPTION_KEY_CURRENT"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const b64_1 = Buffer.alloc(32, 1).toString("base64");
  const b64_2 = Buffer.alloc(32, 2).toString("base64");

  test("unset means no BYOK (returns undefined)", () => {
    delete process.env.KEY_ENCRYPTION_KEYS;
    delete process.env.KEY_ENCRYPTION_KEY_CURRENT;
    expect(keyEncryptionSettings()).toBeUndefined();

    process.env.KEY_ENCRYPTION_KEYS = "";
    expect(keyEncryptionSettings()).toBeUndefined();

    process.env.KEY_ENCRYPTION_KEYS = "   ";
    expect(keyEncryptionSettings()).toBeUndefined();
  });

  test("valid keys and current version are parsed correctly", () => {
    process.env.KEY_ENCRYPTION_KEYS = `v1:${b64_1},v2:${b64_2}`;
    process.env.KEY_ENCRYPTION_KEY_CURRENT = "v1";

    const settings = keyEncryptionSettings();
    expect(settings).toBeDefined();
    expect(settings?.currentVersion).toBe("v1");
    expect(settings?.keys.get("v1")).toEqual(Buffer.alloc(32, 1));
    expect(settings?.keys.get("v2")).toEqual(Buffer.alloc(32, 2));
  });

  test("hazard: handles whitespace around entries and versions", () => {
    process.env.KEY_ENCRYPTION_KEYS = `  v1:${b64_1}  ,   v2:${b64_2}  `;
    process.env.KEY_ENCRYPTION_KEY_CURRENT = "  v2  ";

    const settings = keyEncryptionSettings();
    expect(settings).toBeDefined();
    expect(settings?.currentVersion).toBe("v2");
    expect(settings?.keys.size).toBe(2);
  });

  test("hazard: missing colon throws clear error without key material", () => {
    process.env.KEY_ENCRYPTION_KEYS = `v1${b64_1}`;
    process.env.KEY_ENCRYPTION_KEY_CURRENT = "v1";

    expect(() => keyEncryptionSettings()).toThrow(/missing colon separator/);
    try {
      keyEncryptionSettings();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain(b64_1);
    }
  });

  test("hazard: bad base64 throws clear error without key material", () => {
    process.env.KEY_ENCRYPTION_KEYS = "v1:not-valid-base64!!!";
    process.env.KEY_ENCRYPTION_KEY_CURRENT = "v1";

    expect(() => keyEncryptionSettings()).toThrow(/Invalid base64 key/);
    try {
      keyEncryptionSettings();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("not-valid-base64!!!");
    }
  });

  test("hazard: key decoding to 31 bytes throws clear error", () => {
    const b64_31 = Buffer.alloc(31, 1).toString("base64");
    process.env.KEY_ENCRYPTION_KEYS = `v1:${b64_31}`;
    process.env.KEY_ENCRYPTION_KEY_CURRENT = "v1";

    expect(() => keyEncryptionSettings()).toThrow(/must decode to exactly 32 bytes \(got 31\)/);
    try {
      keyEncryptionSettings();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain(b64_31);
    }
  });

  test("hazard: key decoding to 33 bytes throws clear error", () => {
    const b64_33 = Buffer.alloc(33, 1).toString("base64");
    process.env.KEY_ENCRYPTION_KEYS = `v1:${b64_33}`;
    process.env.KEY_ENCRYPTION_KEY_CURRENT = "v1";

    expect(() => keyEncryptionSettings()).toThrow(/must decode to exactly 32 bytes \(got 33\)/);
    try {
      keyEncryptionSettings();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain(b64_33);
    }
  });

  test("hazard: duplicate version throws clear error", () => {
    process.env.KEY_ENCRYPTION_KEYS = `v1:${b64_1},v1:${b64_2}`;
    process.env.KEY_ENCRYPTION_KEY_CURRENT = "v1";

    expect(() => keyEncryptionSettings()).toThrow(/Duplicate key encryption version "v1"/);
  });

  test("hazard: current version missing throws clear error", () => {
    process.env.KEY_ENCRYPTION_KEYS = `v1:${b64_1}`;
    delete process.env.KEY_ENCRYPTION_KEY_CURRENT;

    expect(() => keyEncryptionSettings()).toThrow(
      "KEY_ENCRYPTION_KEY_CURRENT is required when KEY_ENCRYPTION_KEYS is set.",
    );

    process.env.KEY_ENCRYPTION_KEY_CURRENT = "   ";
    expect(() => keyEncryptionSettings()).toThrow(
      "KEY_ENCRYPTION_KEY_CURRENT is required when KEY_ENCRYPTION_KEYS is set.",
    );
  });

  test("hazard: current version not in list throws clear error", () => {
    process.env.KEY_ENCRYPTION_KEYS = `v1:${b64_1}`;
    process.env.KEY_ENCRYPTION_KEY_CURRENT = "v2";

    expect(() => keyEncryptionSettings()).toThrow(
      'KEY_ENCRYPTION_KEY_CURRENT "v2" not found in KEY_ENCRYPTION_KEYS.',
    );
  });

  test("hazard: malformed version format throws clear error", () => {
    process.env.KEY_ENCRYPTION_KEYS = `notv:${b64_1}`;
    process.env.KEY_ENCRYPTION_KEY_CURRENT = "notv";

    expect(() => keyEncryptionSettings()).toThrow(/a version must follow the "v<n>" format/);
  });

  test("hazard: a key misplaced in the version position is never echoed", () => {
    process.env.KEY_ENCRYPTION_KEYS = `${b64_1}:v1`;
    process.env.KEY_ENCRYPTION_KEY_CURRENT = "v1";

    expect(() => keyEncryptionSettings()).toThrow(/a version must follow/);
    try {
      keyEncryptionSettings();
      expect.unreachable("keyEncryptionSettings should have thrown");
    } catch (error) {
      expect((error as Error).message).not.toContain(b64_1);
    }
  });

  test("hazard: a key misplaced in KEY_ENCRYPTION_KEY_CURRENT is never echoed", () => {
    process.env.KEY_ENCRYPTION_KEYS = `v1:${b64_1}`;
    process.env.KEY_ENCRYPTION_KEY_CURRENT = b64_1;

    try {
      keyEncryptionSettings();
      expect.unreachable("keyEncryptionSettings should have thrown");
    } catch (error) {
      expect((error as Error).message).toBe(
        'KEY_ENCRYPTION_KEY_CURRENT is not a version ("v<n>") in KEY_ENCRYPTION_KEYS.',
      );
    }
  });

  test("hazard: empty entry throws clear error", () => {
    process.env.KEY_ENCRYPTION_KEYS = `v1:${b64_1},`;
    process.env.KEY_ENCRYPTION_KEY_CURRENT = "v1";

    expect(() => keyEncryptionSettings()).toThrow(/empty entry found/);
  });

  test("hazard: base64 with invalid padding throws clear error", () => {
    process.env.KEY_ENCRYPTION_KEYS = "v1:AAAAA=";
    process.env.KEY_ENCRYPTION_KEY_CURRENT = "v1";

    expect(() => keyEncryptionSettings()).toThrow(/Invalid base64 key/);
  });
});
