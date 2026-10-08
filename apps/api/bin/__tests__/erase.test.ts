import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { migratedDatabase } from "../../server/lib/db/__tests__/pglite-client.js";
import type { SqlClient } from "../../server/lib/db/sql-client.js";
import { USAGE_ERASE, parseEraseArgs, runErase } from "../erase.js";
import {
  seedWorld,
  dumpDatabase,
  rowsContaining,
  TARGET,
  BYSTANDER,
  LOCAL_OWNER,
} from "../../server/lib/deletion/__tests__/erase-user-fixtures.js";

describe("erase CLI (bin/erase.ts)", () => {
  let db: SqlClient;
  let endSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    db = await migratedDatabase();
    await seedWorld(db);
    endSpy = vi.spyOn(db, "end").mockResolvedValue(undefined);
  }, 30_000);

  afterEach(async () => {
    endSpy.mockRestore();
    await db.end();
    vi.restoreAllMocks();
  });

  test("erase CLI refuses unknown flags and a missing value before opening anything", async () => {
    const open = vi.fn();
    const log: string[] = [];

    await expect(runErase(["--bogus"], open, (l) => log.push(l))).rejects.toThrow(USAGE_ERASE);
    await expect(runErase(["--email"], open, (l) => log.push(l))).rejects.toThrow(USAGE_ERASE);
    await expect(runErase(["--user"], open, (l) => log.push(l))).rejects.toThrow(USAGE_ERASE);
    await expect(runErase([], open, (l) => log.push(l))).rejects.toThrow(USAGE_ERASE);

    expect(open).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  test("erase CLI refuses a repeated flag both identity flags or neither", async () => {
    const open = vi.fn();
    const log: string[] = [];

    await expect(
      runErase(["--email", "a@x.com", "--email", "b@x.com"], open, (l) => log.push(l)),
    ).rejects.toThrow(USAGE_ERASE);
    await expect(
      runErase(["--user", "u1", "--user", "u2"], open, (l) => log.push(l)),
    ).rejects.toThrow(USAGE_ERASE);
    await expect(
      runErase(["--email", "a@x.com", "--user", "u1"], open, (l) => log.push(l)),
    ).rejects.toThrow(USAGE_ERASE);
    await expect(runErase(["--apply"], open, (l) => log.push(l))).rejects.toThrow(USAGE_ERASE);

    expect(open).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  test("erase CLI refuses apply together with dry-run", async () => {
    const open = vi.fn();
    const log: string[] = [];

    await expect(
      runErase(["--email", "a@x.com", "--apply", "--dry-run"], open, (l) => log.push(l)),
    ).rejects.toThrow(USAGE_ERASE);

    expect(open).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });

  test("erase CLI parses an email or a user id and defaults to a dry run", () => {
    expect(parseEraseArgs(["--email", "a@x.com"])).toEqual({
      ref: { email: "a@x.com" },
      apply: false,
    });
    expect(parseEraseArgs(["--user", "u1", "--apply"])).toEqual({
      ref: { userId: "u1" },
      apply: true,
    });
    expect(parseEraseArgs(["--user", "u1", "--dry-run"])).toEqual({
      ref: { userId: "u1" },
      apply: false,
    });
  });

  test("erase CLI dry run prints counts and never an email or name", async () => {
    const before = await dumpDatabase(db);
    const log: string[] = [];

    await runErase(
      ["--email", TARGET.email],
      () => db,
      (l) => log.push(l),
    );

    expect(log).toEqual([
      "  brief versions re-attributed: 1",
      "  decisions re-attributed: 1",
      "  provider keys re-attributed: 1",
      "  campaigns re-attributed: 1",
      "  deletion requests re-attributed: 1",
      "  drafts deleted: 1",
      "  last-opened pointers deleted: 1",
      "  verification rows deleted: 2",
      "  invitations to the user deleted: 1",
      "  invitations from the user deleted: 1",
      "  sessions deleted: 1",
      "  accounts deleted: 1",
      "  memberships deleted: 1",
      "  team memberships deleted: 1",
      "  teams recounted: 1",
      "  Dry run: nothing changed. Re-run with --apply to erase.",
    ]);
    expect(log.join("\n").toLowerCase()).not.toContain(TARGET.email.toLowerCase());
    expect(log.join("\n").toLowerCase()).not.toContain(TARGET.name.toLowerCase());
    expect(log.join("\n").toLowerCase()).not.toContain(TARGET.id.toLowerCase());
    expect(log.join("\n")).not.toContain("erased:");
    expect(await dumpDatabase(db)).toEqual(before);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  test("erase CLI apply erases the user and prints the token and counts only", async () => {
    const log: string[] = [];

    await runErase(
      ["--user", TARGET.id, "--apply"],
      () => db,
      (l) => log.push(l),
    );

    const last = log[log.length - 1]!;
    expect(last).toMatch(/^  Erased\. Token erased:[0-9a-f-]{36}\.$/);
    const printedToken = last.match(/^  Erased\. Token (erased:[0-9a-f-]{36})\.$/)![1];

    const { rows } = await db.query<{ subject: string }>(
      `select subject from deletion where kind = 'user' and purged_at is not null`,
    );
    expect(rows).toHaveLength(1);
    expect(printedToken).toBe(rows[0]!.subject);

    const gone = await db.query<{ n: number }>(
      `select count(*)::int as n from "user" where id = 'u-target'`,
    );
    expect(gone.rows[0]!.n).toBe(0);

    const bystander = await db.query<{ id: string }>(
      `select id from "user" where id = '${BYSTANDER.id}'`,
    );
    expect(bystander.rows).toHaveLength(1);
    const bystanderDrafts = await db.query<{ n: number }>(
      `select count(*)::int as n from draft where user_id = '${BYSTANDER.id}'`,
    );
    expect(bystanderDrafts.rows[0]!.n).toBeGreaterThan(0);

    expect(await rowsContaining(db, TARGET.email)).toEqual([]);
    expect(await rowsContaining(db, TARGET.id)).toEqual([]);

    expect(log.join("\n")).not.toContain(TARGET.email);
    expect(log.join("\n")).not.toContain(TARGET.name);
    expect(log.join("\n")).not.toContain(TARGET.id);
  });

  test("erase CLI apply twice answers no such user the second time and changes nothing", async () => {
    await runErase(
      ["--email", TARGET.email, "--apply"],
      () => db,
      () => {},
    );
    const before = await dumpDatabase(db);

    await expect(
      runErase(
        ["--email", TARGET.email, "--apply"],
        () => db,
        () => {},
      ),
    ).rejects.toThrow("erase: no such user.");

    expect(await dumpDatabase(db)).toEqual(before);
    expect(endSpy).toHaveBeenCalledTimes(2);
  });

  test("erase CLI refuses the only owner of an org and changes nothing", async () => {
    const before = await dumpDatabase(db);
    const log: string[] = [];
    let message = "";
    try {
      await runErase(
        ["--user", LOCAL_OWNER.id, "--apply"],
        () => db,
        (l) => log.push(l),
      );
    } catch (e) {
      message = e instanceof Error ? (e as Error).message : String(e);
    }
    expect(message).toBe(
      "erase refused: the user is the only owner of org local; move ownership or delete the org first.",
    );
    expect(message).not.toContain(LOCAL_OWNER.email);
    expect(message).not.toContain(LOCAL_OWNER.name);
    expect(message).not.toContain(LOCAL_OWNER.id);
    expect(log).toEqual([]);
    expect(await dumpDatabase(db)).toEqual(before);
  });

  test("erase CLI refuses an unknown user without echoing the identity", async () => {
    const before = await dumpDatabase(db);
    let message = "";
    try {
      await runErase(
        ["--email", "nobody@example.com", "--apply"],
        () => db,
        () => {},
      );
    } catch (e) {
      message = e instanceof Error ? (e as Error).message : String(e);
    }
    expect(message).toBe("erase: no such user.");
    expect(message).not.toContain("nobody");
    expect(await dumpDatabase(db)).toEqual(before);
  });

  test("erase CLI closes the database when the erasure fails", async () => {
    const broken = {
      ...db,
      transaction: vi.fn().mockRejectedValue(new Error("boom")),
      end: vi.fn().mockResolvedValue(undefined),
    } as unknown as SqlClient;

    await expect(
      runErase(
        ["--email", TARGET.email],
        () => broken,
        () => {},
      ),
    ).rejects.toThrow("boom");
    expect(broken.end).toHaveBeenCalledTimes(1);
  });
});
