import { describe, test, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
import { databaseSettings, outputRoot, storeBackend } from "../config.js";

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
