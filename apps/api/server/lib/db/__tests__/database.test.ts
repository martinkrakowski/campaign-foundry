import { describe, test, expect, afterEach } from "vitest";
import { database, resetDatabase, setDatabase } from "../database.js";
import { pgliteClient } from "./pglite-client.js";

describe("database() (PT-3)", () => {
  const saved = { url: process.env.DATABASE_URL, ca: process.env.DATABASE_CA_PATH };
  afterEach(async () => {
    resetDatabase();
    for (const [key, value] of [
      ["DATABASE_URL", saved.url],
      ["DATABASE_CA_PATH", saved.ca],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("builds one client from the environment on first use, and reuses it", async () => {
    process.env.DATABASE_URL = "postgres://me@localhost/cf";
    delete process.env.DATABASE_CA_PATH;
    const first = database();
    expect(database()).toBe(first);
    await first.end(); // never connected
  });

  test("reads a relative CA path against the project root, and refuses one that is missing", () => {
    process.env.DATABASE_URL = "postgres://me@db.example.com/cf";
    process.env.DATABASE_CA_PATH = "certs/does-not-exist.pem";
    expect(() => database()).toThrow(/ENOENT.*certs\/does-not-exist\.pem/);
  });

  test("a set database serves every caller until reset", async () => {
    const db = pgliteClient();
    setDatabase(db);
    expect(database()).toBe(db);
    resetDatabase();
    process.env.DATABASE_URL = "postgres://me@localhost/cf";
    expect(database()).not.toBe(db);
    await db.end();
  });
});
