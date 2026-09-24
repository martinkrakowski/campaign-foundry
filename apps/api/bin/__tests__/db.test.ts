import { describe, test, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE, connect, main } from "../db.js";
import { pgliteClient } from "../../server/lib/db/__tests__/pglite-client.js";
import type { SqlClient } from "../../server/lib/db/sql-client.js";
import { loadMigrations } from "../../server/lib/db/migrate.js";

describe("db CLI (PT-3)", () => {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  afterEach(() => {
    lines.length = 0;
  });

  test("ping reports the server and closes its connection", async () => {
    const db = pgliteClient();
    const end = vi.spyOn(db, "end");
    await main("ping", () => db, log);
    expect(lines[0]).toMatch(/^ {2}Connected: PostgreSQL /);
    expect(end).toHaveBeenCalled();
  });

  test("migrate applies the shipped migrations, then reports the database up to date", async () => {
    const db = pgliteClient();
    const keepOpen: SqlClient = { ...db, end: async () => undefined };
    await main("migrate", () => keepOpen, log);
    await main("migrate", () => keepOpen, log);
    const shipped = (await loadMigrations()).map((m) => m.id);
    expect(shipped[0]).toBe("0001_org");
    expect(lines).toEqual([
      `  Applied ${shipped.length} migration(s): ${shipped.join(", ")}`,
      "  The database is up to date.",
    ]);
    await db.end();
  });

  test("anything else is the usage, and opens nothing", async () => {
    const open = vi.fn();
    await expect(main(undefined, open, log)).rejects.toThrow(USAGE);
    await expect(main("drop", open, log)).rejects.toThrow(USAGE);
    expect(open).not.toHaveBeenCalled();
    await expect(main("drop")).rejects.toThrow(USAGE); // the defaults are never reached
  });

  describe("connect", () => {
    const saved = { url: process.env.DATABASE_URL, ca: process.env.DATABASE_CA_PATH };
    let dir: string | undefined;
    afterEach(() => {
      for (const [key, value] of [
        ["DATABASE_URL", saved.url],
        ["DATABASE_CA_PATH", saved.ca],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    test("builds a one-connection client from the environment, verifying against the CA file it reads", async () => {
      dir = mkdtempSync(join(tmpdir(), "cf-ca-"));
      writeFileSync(join(dir, "ca.pem"), "PEM");
      process.env.DATABASE_URL = "postgres://me@db.example.com:5432/cf";
      process.env.DATABASE_CA_PATH = join(dir, "ca.pem");
      const build = vi.fn(() => pgliteClient());
      await connect(build).end();
      expect(build).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "db.example.com",
          max: 1,
          ssl: { ca: "PEM", rejectUnauthorized: true },
        }),
      );
      await connect().end(); // the default builder: a real pool, never connected
    });

    test("a CA file that cannot be read is refused", () => {
      dir = mkdtempSync(join(tmpdir(), "cf-ca-"));
      process.env.DATABASE_URL = "postgres://me@db.example.com:5432/cf";
      process.env.DATABASE_CA_PATH = join(dir, "missing.pem");
      expect(() => connect()).toThrow(/ENOENT/);
    });

    test("refuses a remote database with no CA before opening anything", () => {
      process.env.DATABASE_URL = "postgres://me@db.example.com:5432/cf";
      process.env.DATABASE_CA_PATH = "";
      expect(() => connect()).toThrow(/DATABASE_CA_PATH is not set/);
    });
  });
});
