import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { migratedDatabase } from "../../server/lib/db/__tests__/pglite-client.js";
import type { SqlClient, SqlQuery } from "../../server/lib/db/sql-client.js";
import { EXIT_FOUND, HELP_COLLIDING, USAGE_COLLIDING, main } from "../colliding-pairs.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

let db: SqlClient;
let seen: string[];
let lines: string[];

/** The real database behind a spy: it records every statement and `end` leaves it open. */
function spy(inner: SqlClient): SqlClient {
  return {
    async query<R = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      seen.push(text);
      return inner.query<R>(text, params);
    },
    async exec(text: string) {
      seen.push(text);
      return inner.exec(text);
    },
    async transaction<T>(work: (tx: SqlQuery) => Promise<T>) {
      seen.push("transaction");
      return inner.transaction(work);
    },
    async end() {},
  };
}

const dump = async (): Promise<string> =>
  JSON.stringify((await db.query(`select * from campaign order by id`)).rows);

describe("yarn report:colliding-pairs", () => {
  beforeEach(async () => {
    db = await migratedDatabase();
    seen = [];
    lines = [];
    await db.query(`insert into org (id, name) values ('acme', 'acme'), ('other', 'other')`);
  });
  afterEach(async () => {
    await db.end();
  });

  test("no pairs: the zero line and exit 0", async () => {
    await db.query(`insert into campaign (id, org_id, slug) values ($1, 'acme', 'summer')`, [A]);
    const code = await main(
      [],
      () => spy(db),
      (l) => lines.push(l),
    );
    expect(code).toBe(0);
    expect(lines).toEqual(["  No colliding campaign pairs found."]);
  });

  test("one pair is printed with the count and the run exits 2", async () => {
    await db.query(`insert into campaign (id, org_id, slug) values ($1, 'acme', $2)`, [A, B]);
    await db.query(`insert into campaign (id, org_id, slug) values ($1, 'acme', 'winter')`, [B]);
    const code = await main(
      [],
      () => spy(db),
      (l) => lines.push(l),
    );
    expect(code).toBe(EXIT_FOUND);
    expect(lines).toEqual([
      `  org acme: campaign ${A} has slug "${B}", which is the uuid of campaign ${B} (slug "winter")`,
      "  1 colliding pair(s). Nothing was changed.",
    ]);
  });

  test("a slug equal to a campaign uuid of another organisation is not reported", async () => {
    await db.query(`insert into campaign (id, org_id, slug) values ($1, 'acme', $2)`, [A, B]);
    await db.query(`insert into campaign (id, org_id, slug) values ($1, 'other', 'winter')`, [B]);
    expect(
      await main(
        [],
        () => spy(db),
        (l) => lines.push(l),
      ),
    ).toBe(0);
    expect(lines).toEqual(["  No colliding campaign pairs found."]);
  });

  test("a run writes nothing: one SELECT, no INSERT, UPDATE or DELETE, rows unchanged", async () => {
    await db.query(`insert into campaign (id, org_id, slug) values ($1, 'acme', $2)`, [A, B]);
    await db.query(`insert into campaign (id, org_id, slug) values ($1, 'acme', 'winter')`, [B]);
    const before = await dump();
    await main(
      [],
      () => spy(db),
      (l) => lines.push(l),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^\s*select\b/i);
    expect(seen.join("\n")).not.toMatch(/\b(insert|update|delete|alter|drop|truncate)\b/i);
    expect(await dump()).toBe(before);
  });

  test("--help prints the usage, says report only, and does not open the database", async () => {
    const open = (): SqlClient => {
      throw new Error("must not connect");
    };
    expect(await main(["--help"], open, (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual(HELP_COLLIDING);
    expect(lines.join("\n")).toContain("renames nothing and writes nothing");
  });

  test("any other argument is refused with the usage", async () => {
    await expect(
      main(
        ["--fix"],
        () => spy(db),
        (l) => lines.push(l),
      ),
    ).rejects.toThrow(USAGE_COLLIDING);
    expect(seen).toEqual([]);
  });
});
