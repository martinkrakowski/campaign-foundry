import { describe, test, expect, afterEach, vi } from "vitest";
import { USAGE, main } from "../auth.js";
import { migratedDatabase } from "../../server/lib/db/__tests__/pglite-client.js";
import type { SqlClient } from "../../server/lib/db/sql-client.js";

async function insertUser(db: SqlClient, id: string, email: string) {
  await db.query(
    'insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, $1, $2, true, now(), now())',
    [id, email],
  );
}

async function rolesOf(db: SqlClient, userId: string): Promise<string[]> {
  const { rows } = await db.query<{ role: string }>(
    "select role from member where org_id = 'local' and user_id = $1",
    [userId],
  );
  return rows.map((r) => r.role);
}

describe("auth:bootstrap (PT-1a item 6)", () => {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  afterEach(() => {
    lines.length = 0;
  });

  test("no email is the usage, and opens nothing", async () => {
    const open = vi.fn();
    await expect(main(undefined, open, log)).rejects.toThrow(USAGE);
    expect(open).not.toHaveBeenCalled();
  });

  test("a user who has never signed in is refused, by name", async () => {
    const db = await migratedDatabase();
    await expect(main("ghost@example.com", () => db, log)).rejects.toThrow(
      'No user with email "ghost@example.com" has signed in yet.',
    );
  });

  test("makes an existing, membership-less user an owner of local", async () => {
    const db = await migratedDatabase();
    const keepOpen: SqlClient = { ...db, end: async () => undefined };
    await insertUser(db, "u1", "owner@example.com");

    await main("owner@example.com", () => keepOpen, log);

    expect(await rolesOf(db, "u1")).toEqual(["owner"]);
    expect(lines).toEqual(['  owner@example.com is now an owner of "local".']);
    await db.end();
  });

  test("is idempotent: running it again on an already-owner user changes nothing", async () => {
    const db = await migratedDatabase();
    const keepOpen: SqlClient = { ...db, end: async () => undefined };
    await insertUser(db, "u1", "owner@example.com");
    await main("owner@example.com", () => keepOpen, log);

    await main("owner@example.com", () => keepOpen, log);

    expect(await rolesOf(db, "u1")).toEqual(["owner"]);
    await db.end();
  });

  test("upgrades an existing lesser membership to owner", async () => {
    const db = await migratedDatabase();
    const keepOpen: SqlClient = { ...db, end: async () => undefined };
    await insertUser(db, "u1", "viewer@example.com");
    await db.query(
      "insert into member (id, org_id, user_id, role, created_at) values ('m1', 'local', 'u1', 'viewer', now())",
    );

    await main("viewer@example.com", () => keepOpen, log);

    expect(await rolesOf(db, "u1")).toEqual(["owner"]);
    await db.end();
  });

  test("closes the connection even when bootstrap throws", async () => {
    const db = await migratedDatabase();
    const end = vi.spyOn(db, "end");
    await expect(main("ghost@example.com", () => db, log)).rejects.toThrow();
    expect(end).toHaveBeenCalled();
  });
});
