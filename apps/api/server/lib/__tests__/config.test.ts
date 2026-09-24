import { describe, test, expect, afterEach } from "vitest";
import { resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
import { databaseSettings, outputRoot } from "../config.js";

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
