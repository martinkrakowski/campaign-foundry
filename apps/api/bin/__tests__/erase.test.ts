import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SqlClient, SqlQuery } from "../../server/lib/db/sql-client.js";
import { migratedDatabase } from "../../server/lib/db/__tests__/pglite-client.js";
import {
  USAGE_ERASE,
  parseEraseArgs,
  runErase,
  EraseIncompleteError,
  exitCodeFor,
  reportFailure,
} from "../erase.js";
import { eraseUser, ErasePassTwoError } from "../../server/lib/deletion/erase-user.js";
import {
  seedWorld,
  dumpDatabase,
  rowsContaining,
  TARGET,
  BYSTANDER,
  LOCAL_OWNER,
} from "../../server/lib/deletion/__tests__/erase-user-fixtures.js";
import type { World } from "../../server/lib/deletion/__tests__/erase-user-fixtures.js";

/** Insert one surviving row per actor column, all carrying `TARGET.id`. */
async function insertSurvivors(db: SqlClient, world: World): Promise<void> {
  await db.query(
    `insert into brief_version (campaign_id, version, body, revision, actor) values ($1, 3, '{}', 'r2', $2)`,
    [world.localCampaignId, TARGET.id],
  );
  await db.query(
    `insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run) values ($1, $2, $3, 1, 'approved', $4, now(), 'run-2')`,
    ["local", world.localCampaignId, "ak-survivor", TARGET.id],
  );
  await db.query(
    `insert into provider_key (org_id, provider, ciphertext, iv, tag, sealed_dek, dek_iv, dek_tag, kek_version, last4, created_by) values ('local', 'firefly', 'ct', 'iv', 'tag', 'dek', 'div', 'dtag', 'v1', 'abcd', $1)`,
    [TARGET.id],
  );
  await db.query(
    `insert into campaign (org_id, slug, deleted_at, deleted_by) values ('local', 'c-survivor', now(), $1)`,
    [TARGET.id],
  );
  await db.query(
    `insert into deletion (org_id, kind, subject, requested_by, not_before) values ('local', 'campaign', 'survivor-subject', $1, now())`,
    [TARGET.id],
  );
}

/** Proxy: after `transaction` resolves, insert surviving rows, then return. */
function withPostCommitInserts(db: SqlClient, world: World): SqlClient {
  const originalTransaction = db.transaction.bind(db);
  return {
    ...db,
    transaction: async <T>(work: (tx: SqlQuery) => Promise<T>): Promise<T> => {
      const result = await originalTransaction(work);
      await insertSurvivors(db, world);
      return result;
    },
  };
}

/** Proxy: when the countActorRows select is about to run, insert a decision row. */
function withInsertOnCount(db: SqlClient, insert: () => Promise<void>): SqlClient {
  return {
    ...db,
    query: async <R = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<{ rows: R[] }> => {
      if (text.includes('as "briefVersions"')) await insert();
      return db.query<R>(text, params);
    },
  };
}

describe("erase CLI (bin/erase.ts)", () => {
  let db: SqlClient;
  let world: World;
  let endSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    db = await migratedDatabase();
    world = await seedWorld(db);
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
      mode: "erase",
      ref: { email: "a@x.com" },
      apply: false,
    });
    expect(parseEraseArgs(["--user", "u1", "--apply"])).toEqual({
      mode: "erase",
      ref: { userId: "u1" },
      apply: true,
    });
    expect(parseEraseArgs(["--user", "u1", "--dry-run"])).toEqual({
      mode: "erase",
      ref: { userId: "u1" },
      apply: false,
    });
  });

  test("erase CLI parses a finish mode with the right shape", () => {
    expect(
      parseEraseArgs([
        "--finish",
        "erased:00000000-0000-4000-8000-000000000000",
        "--user",
        "u1",
        "--apply",
      ]),
    ).toEqual({
      mode: "finish",
      token: "erased:00000000-0000-4000-8000-000000000000",
      userId: "u1",
      apply: true,
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
      message = e instanceof Error ? e.message : String(e);
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
      message = e instanceof Error ? e.message : String(e);
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

  // ---- New tests for PT-9l3 repair ----

  test("8. apply with rows repaired in pass two prints 'repaired after commit' lines, no throw", async () => {
    const proxy = withPostCommitInserts(db, world);
    const log: string[] = [];

    await runErase(
      ["--user", TARGET.id, "--apply"],
      () => proxy,
      (l) => log.push(l),
    );

    const erasedIdx = log.findIndex((l) => l.includes("Erased. Token"));
    expect(erasedIdx).toBeGreaterThanOrEqual(0);
    const repairedLines = log.slice(erasedIdx + 1);
    expect(repairedLines).toEqual([
      "  repaired after commit: 1 brief versions re-attributed",
      "  repaired after commit: 1 decisions re-attributed",
      "  repaired after commit: 1 provider keys re-attributed",
      "  repaired after commit: 1 campaigns re-attributed",
      "  repaired after commit: 1 deletion requests re-attributed",
    ]);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  test("9. apply --email with a row remaining: exact message, id once, log clean, reportFailure 3", async () => {
    const proxy = withInsertOnCount(db, async () => {
      await db.query(
        `insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run) values ($1, $2, $3, 1, 'approved', $4, now(), 'run-3')`,
        ["local", world.localCampaignId, "ak-after-scan", TARGET.id],
      );
    });
    const log: string[] = [];
    let caught: unknown;

    try {
      await runErase(
        ["--email", TARGET.email, "--apply"],
        () => proxy,
        (l) => log.push(l),
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(EraseIncompleteError);
    const message = (caught as Error).message;
    const token = log
      .find((l) => l.includes("Erased. Token"))!
      .match(/Token (erased:[0-9a-f-]{36})/)![1];

    // Exact three-sentence message with real token and id.
    expect(message).toBe(
      `erase incomplete: rows written while the erasure ran still name the user. Token ${token}. To finish, run: yarn erase:user --finish ${token} --user ${TARGET.id} --apply\nThat line contains the erased user's internal id. It is needed once, to finish this erasure.\nDo not paste it into a ticket, a chat or a log.`,
    );
    // The id appears exactly once, inside the --finish command.
    expect(message.split(TARGET.id).length).toBe(2);

    // Exact STILL NAMING THE USER lines.
    expect(log.join("\n")).toContain("  STILL NAMING THE USER: 1 decisions re-attributed");

    // stdout (log) leaks neither id, email, nor name.
    const lowerLog = log.join("\n").toLowerCase();
    expect(lowerLog).not.toContain(TARGET.email.toLowerCase());
    expect(lowerLog).not.toContain(TARGET.name.toLowerCase());
    expect(lowerLog).not.toContain(TARGET.id.toLowerCase());

    // stderr message contains neither email nor name.
    const lowerMsg = message.toLowerCase();
    expect(lowerMsg).not.toContain(TARGET.email.toLowerCase());
    expect(lowerMsg).not.toContain(TARGET.name.toLowerCase());

    // reportFailure writes one entry to err (stderr), contains the id, returns 3.
    const errLines: string[] = [];
    const code = reportFailure(caught as Error, (l) => errLines.push(l));
    expect(code).toBe(3);
    expect(errLines).toHaveLength(1);
    expect(errLines[0]).toContain(TARGET.id);

    expect(exitCodeFor(caught as Error)).toBe(3);
    expect(exitCodeFor(new Error("x"))).toBe(1);
    expect(exitCodeFor("x")).toBe(1);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  test("reportFailure stringifies a non-Error and returns 1", () => {
    const errLines: string[] = [];
    expect(reportFailure("string error", (l) => errLines.push(l))).toBe(1);
    expect(errLines).toEqual(["  x  string error"]);
  });

  test("10. log of incomplete path leaks no email/name/id; message leaks no email/name", async () => {
    const proxy = withInsertOnCount(db, async () => {
      await db.query(
        `insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run) values ($1, $2, $3, 1, 'approved', $4, now(), 'run-3')`,
        ["local", world.localCampaignId, "ak-after-scan", TARGET.id],
      );
    });
    const log: string[] = [];
    let caught: unknown;

    try {
      await runErase(
        ["--user", TARGET.id, "--apply"],
        () => proxy,
        (l) => log.push(l),
      );
    } catch (e) {
      caught = e;
    }

    const message = caught instanceof Error ? caught.message : String(caught);
    const lowerLog = log.join("\n").toLowerCase();
    const lowerMsg = message.toLowerCase();

    // stdout (log): no id, email, or name.
    expect(lowerLog).not.toContain(TARGET.email.toLowerCase());
    expect(lowerLog).not.toContain(TARGET.name.toLowerCase());
    expect(lowerLog).not.toContain(TARGET.id.toLowerCase());

    // stderr message: no email or name (id is intentionally present).
    expect(lowerMsg).not.toContain(TARGET.email.toLowerCase());
    expect(lowerMsg).not.toContain(TARGET.name.toLowerCase());
  });

  test("11. --finish finishes and prints 'Finished. Token ...'", async () => {
    const outcome = await eraseUser(db, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");
    const token = outcome.token;
    const log: string[] = [];

    await runErase(
      ["--finish", token, "--user", TARGET.id, "--apply"],
      () => db,
      (l) => log.push(l),
    );

    expect(log).toContain(`  Finished. Token ${token}.`);
    // No leak of personal data
    const lowerLog = log.join("\n").toLowerCase();
    expect(lowerLog).not.toContain(TARGET.email.toLowerCase());
    expect(lowerLog).not.toContain(TARGET.name.toLowerCase());
    expect(lowerLog).not.toContain(TARGET.id.toLowerCase());
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  test("11b. --finish with a row that keeps reappearing: exact message, STILL line, no leak", async () => {
    const outcome = await eraseUser(db, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");
    const token = outcome.token;

    const proxy = withInsertOnCount(db, async () => {
      await db.query(
        `insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run) values ($1, $2, $3, 1, 'approved', $4, now(), 'run-3')`,
        ["local", world.localCampaignId, "ak-after-scan", TARGET.id],
      );
    });

    const log: string[] = [];
    let caught: unknown;
    try {
      await runErase(
        ["--finish", token, "--user", TARGET.id, "--apply"],
        () => proxy,
        (l) => log.push(l),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EraseIncompleteError);
    const message = (caught as Error).message;
    expect(message).toBe(
      `erase incomplete: rows written while the erasure ran still name the user. Token ${token}. To finish, run: yarn erase:user --finish ${token} --user ${TARGET.id} --apply\nThat line contains the erased user's internal id. It is needed once, to finish this erasure.\nDo not paste it into a ticket, a chat or a log.`,
    );
    expect(message.split(TARGET.id).length).toBe(2);

    // Exact STILL NAMING THE USER line.
    expect(log.join("\n")).toContain("  STILL NAMING THE USER: 1 decisions re-attributed");

    // Log: no id, email, or name. Message: no email or name (id is intended).
    const lowerLog = log.join("\n").toLowerCase();
    const lowerMsg = message.toLowerCase();
    expect(lowerLog).not.toContain(TARGET.email.toLowerCase());
    expect(lowerLog).not.toContain(TARGET.name.toLowerCase());
    expect(lowerLog).not.toContain(TARGET.id.toLowerCase());
    expect(lowerMsg).not.toContain(TARGET.email.toLowerCase());
    expect(lowerMsg).not.toContain(TARGET.name.toLowerCase());
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  test("11c. --finish repairs a planted survivor and prints repaired + Finished lines", async () => {
    const outcome = await eraseUser(db, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");
    const token = outcome.token;

    await db.query(
      `insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run) values ($1, $2, $3, 1, 'approved', $4, now(), 'run-2')`,
      ["local", world.localCampaignId, "ak-survivor-finish", TARGET.id],
    );

    const log: string[] = [];
    await runErase(
      ["--finish", token, "--user", TARGET.id, "--apply"],
      () => db,
      (l) => log.push(l),
    );

    expect(log).toContain("  repaired after commit: 1 decisions re-attributed");
    expect(log).toContain(`  Finished. Token ${token}.`);

    const lowerLog = log.join("\n").toLowerCase();
    expect(lowerLog).not.toContain(TARGET.email.toLowerCase());
    expect(lowerLog).not.toContain(TARGET.name.toLowerCase());
    expect(lowerLog).not.toContain(TARGET.id.toLowerCase());
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  test("7ab. finishErasure refusals change nothing", async () => {
    const outcome = await eraseUser(db, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");

    const before = await dumpDatabase(db);

    // (b) well-formed token, no deletion row
    await expect(
      runErase(
        ["--finish", "erased:00000000-0000-4000-8000-000000000000", "--user", TARGET.id, "--apply"],
        () => db,
        () => {},
      ),
    ).rejects.toThrow("erase: that token is not an erasure token.");
    expect(await dumpDatabase(db)).toEqual(before);

    // (c) malformed tokens
    for (const bad of ["erased:", "erased:not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
      await expect(
        runErase(
          ["--finish", bad, "--user", TARGET.id, "--apply"],
          () => db,
          () => {},
        ),
      ).rejects.toThrow("erase: that token is not an erasure token.");
      expect(await dumpDatabase(db)).toEqual(before);
    }
  });

  test("7d. finishErasure refuses when the user still exists even with a real token", async () => {
    const outcome = await eraseUser(db, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");
    const token = outcome.token;

    const before = await dumpDatabase(db);

    await expect(
      runErase(
        ["--finish", token, "--user", BYSTANDER.id, "--apply"],
        () => db,
        () => {},
      ),
    ).rejects.toThrow("erase: that user still exists; run a normal erasure.");
    expect(await dumpDatabase(db)).toEqual(before);
  });

  test("finish CLI refuses --user cli:erase-user and closes the database", async () => {
    const outcome = await eraseUser(db, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");
    const before = await dumpDatabase(db);

    await expect(
      runErase(
        ["--finish", outcome.token, "--user", "cli:erase-user", "--apply"],
        () => db,
        () => {},
      ),
    ).rejects.toThrow("erase: that id is not a user id.");
    expect(await dumpDatabase(db)).toEqual(before);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  test("12. usage errors: finish without --user", async () => {
    const open = vi.fn();
    await expect(
      runErase(
        ["--finish", "erased:00000000-0000-4000-8000-000000000000", "--apply"],
        open,
        () => {},
      ),
    ).rejects.toThrow(USAGE_ERASE);
    expect(open).not.toHaveBeenCalled();
  });

  test("12. usage errors: finish --email is rejected", async () => {
    const open = vi.fn();
    await expect(
      runErase(
        [
          "--finish",
          "erased:00000000-0000-4000-8000-000000000000",
          "--email",
          "x@y.com",
          "--apply",
        ],
        open,
        () => {},
      ),
    ).rejects.toThrow(USAGE_ERASE);
    expect(open).not.toHaveBeenCalled();
  });

  test("12. usage errors: finish without --apply", async () => {
    const open = vi.fn();
    await expect(
      runErase(
        ["--finish", "erased:00000000-0000-4000-8000-000000000000", "--user", "u1"],
        open,
        () => {},
      ),
    ).rejects.toThrow(USAGE_ERASE);
    expect(open).not.toHaveBeenCalled();
  });

  test("12. usage errors: --finish twice", async () => {
    const open = vi.fn();
    await expect(
      runErase(
        [
          "--finish",
          "erased:00000000-0000-4000-8000-000000000000",
          "--finish",
          "erased:00000000-0000-4000-8000-000000000001",
          "--user",
          "u1",
          "--apply",
        ],
        open,
        () => {},
      ),
    ).rejects.toThrow(USAGE_ERASE);
    expect(open).not.toHaveBeenCalled();
  });

  test("12. usage errors: --email --apply treats --apply as address (rejected)", async () => {
    const open = vi.fn();
    await expect(runErase(["--email", "--apply"], open, () => {})).rejects.toThrow(USAGE_ERASE);
    expect(open).not.toHaveBeenCalled();
  });

  test("12. usage errors: --user --apply same", async () => {
    const open = vi.fn();
    await expect(runErase(["--user", "--apply"], open, () => {})).rejects.toThrow(USAGE_ERASE);
    expect(open).not.toHaveBeenCalled();
  });

  test("12. usage errors: --email empty string", async () => {
    const open = vi.fn();
    await expect(runErase(["--email", "", "--apply"], open, () => {})).rejects.toThrow(USAGE_ERASE);
    expect(open).not.toHaveBeenCalled();
  });

  test("12. usage errors: --finish --apply treats --apply as token (rejected)", async () => {
    const open = vi.fn();
    await expect(runErase(["--finish", "--apply"], open, () => {})).rejects.toThrow(USAGE_ERASE);
    expect(open).not.toHaveBeenCalled();
  });

  test("13. incomplete rejection closes the database", async () => {
    const proxy = withInsertOnCount(db, async () => {
      await db.query(
        `insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run) values ($1, $2, $3, 1, 'approved', $4, now(), 'run-3')`,
        ["local", world.localCampaignId, "ak-after-scan", TARGET.id],
      );
    });

    await expect(
      runErase(
        ["--user", TARGET.id, "--apply"],
        () => proxy,
        () => {},
      ),
    ).rejects.toThrow(EraseIncompleteError);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  test("13. finish refusal closes the database", async () => {
    await expect(
      runErase(
        ["--finish", "erased:00000000-0000-4000-8000-000000000000", "--user", TARGET.id, "--apply"],
        () => db,
        () => {},
      ),
    ).rejects.toThrow("erase: that token is not an erasure token.");
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  test("apply with a failed repair pass prints counts, rejects with ErasePassTwoError, exitCodeFor 3, no leak, db closed", async () => {
    const proxy: SqlClient = {
      ...db,
      query: async <R>(text: string, params?: readonly unknown[]): Promise<{ rows: R[] }> => {
        if (text.includes("update provider_key set created_by")) {
          throw new Error("injected failure");
        }
        return db.query<R>(text, params);
      },
    };
    const log: string[] = [];
    let caught: unknown;
    try {
      await runErase(
        ["--user", TARGET.id, "--apply"],
        () => proxy,
        (l) => log.push(l),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ErasePassTwoError);
    const error = caught as ErasePassTwoError;
    expect(error.token).toMatch(/^erased:[0-9a-f-]{36}$/);
    expect(error.message).toBe(
      `erase committed, but the repair pass failed: injected failure. Token ${error.token}. To finish, run: yarn erase:user --finish ${error.token} --user ${TARGET.id} --apply\nThat line contains the erased user's internal id. It is needed once, to finish this erasure.\nDo not paste it into a ticket, a chat or a log.`,
    );
    expect(error.message.split(TARGET.id).length).toBe(2);

    // Count lines that describe what the transaction changed are printed.
    expect(log).toContain("  brief versions re-attributed: 1");
    expect(log).toContain("  decisions re-attributed: 1");
    expect(log).toContain("  provider keys re-attributed: 1");
    expect(log).toContain("  campaigns re-attributed: 1");
    expect(log).toContain("  deletion requests re-attributed: 1");
    expect(log.join("\n")).not.toContain("Erased. Token");

    // stdout (log): no id, email, or name.
    const lowerLog = log.join("\n").toLowerCase();
    expect(lowerLog).not.toContain(TARGET.email.toLowerCase());
    expect(lowerLog).not.toContain(TARGET.name.toLowerCase());
    expect(lowerLog).not.toContain(TARGET.id.toLowerCase());
    // stderr message: no email or name (id is intended).
    const lowerMsg = error.message.toLowerCase();
    expect(lowerMsg).not.toContain(TARGET.email.toLowerCase());
    expect(lowerMsg).not.toContain(TARGET.name.toLowerCase());

    expect(exitCodeFor(error)).toBe(3);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  test("d. successful --finish prints only Finished line, no id", async () => {
    const outcome = await eraseUser(db, { userId: TARGET.id }, { apply: true });
    if (outcome.outcome !== "erased") throw new Error("expected erased");
    const log: string[] = [];
    await runErase(
      ["--finish", outcome.token, "--user", TARGET.id, "--apply"],
      () => db,
      (l) => log.push(l),
    );
    expect(log).toEqual([`  Finished. Token ${outcome.token}.`]);
    expect(log.join("\n")).not.toContain(TARGET.id);
  });

  test("e. other failures leak no id, email, or name", async () => {
    const cases: { args: readonly string[]; match: string }[] = [
      { args: ["--email", "nobody@example.com", "--apply"], match: "erase: no such user." },
      { args: ["--bogus"], match: USAGE_ERASE },
      { args: ["--user", LOCAL_OWNER.id, "--apply"], match: "erase refused" },
      {
        args: [
          "--finish",
          "erased:00000000-0000-4000-8000-000000000000",
          "--user",
          TARGET.id,
          "--apply",
        ],
        match: "not an erasure token",
      },
      {
        args: [
          "--finish",
          "erased:00000000-0000-4000-8000-000000000000",
          "--user",
          "cli:erase-user",
          "--apply",
        ],
        match: "not an erasure token",
      },
    ];
    for (const { args, match } of cases) {
      const log: string[] = [];
      let message = "";
      try {
        await runErase(
          args,
          () => db,
          (l) => log.push(l),
        );
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(match);
      expect(message).not.toContain(TARGET.id);
      expect(message).not.toContain(TARGET.email);
      expect(message).not.toContain(TARGET.name);
      expect(log.join("\n")).not.toContain(TARGET.id);
      expect(log.join("\n")).not.toContain(TARGET.email);
      expect(log.join("\n")).not.toContain(TARGET.name);
    }
  });

  test("f. no deletion row column contains the erased user id after an incomplete erasure", async () => {
    const proxy = withInsertOnCount(db, async () => {
      await db.query(
        `insert into decision (org_id, campaign_id, asset_key, ordinal, verdict, actor, decided_at, run) values ($1, $2, $3, 1, 'approved', $4, now(), 'run-3')`,
        ["local", world.localCampaignId, "ak-after-scan", TARGET.id],
      );
    });
    try {
      await runErase(
        ["--email", TARGET.email, "--apply"],
        () => proxy,
        () => {},
      );
    } catch {
      // expected
    }
    const { rows } = await db.query<{ requested_by: string; subject: string }>(
      `select requested_by, subject from deletion where requested_by = $1 or subject = $1`,
      [TARGET.id],
    );
    expect(rows).toEqual([]);
  });
});
