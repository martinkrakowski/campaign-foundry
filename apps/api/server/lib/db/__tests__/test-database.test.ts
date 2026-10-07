import { describe, test, expect, afterEach } from "vitest";
import pg from "pg";
import type { Migration } from "../migrate.js";
import { main as pgClean } from "./pg-clean.js";
import {
  dropDatabase,
  processAlive,
  probeServer,
  sweep,
  templateName,
  testDatabaseBackend,
} from "./test-database.js";

/**
 * The server-free half of the test-database harness (D186). Everything here
 * runs with `TEST_PG_URL` unset — the mode the whole suite passes in today — and
 * is the evidence for the parts of the server path that do not need a server:
 * which backend is selected, what a template is named, and what a name means.
 *
 * The parts that do need a server (the template build, the clone, cleanup) are in
 * `test-database.server.test.ts`, which skips itself without `TEST_PG_URL` and
 * runs in CI's server step.
 */

const m = (id: string, sql: string): Migration => ({ id, sql });

const saved = process.env["TEST_PG_URL"];

afterEach(() => {
  if (saved === undefined) delete process.env["TEST_PG_URL"];
  else process.env["TEST_PG_URL"] = saved;
});

describe("testDatabaseBackend", () => {
  test("is pglite unless TEST_PG_URL is set and non-empty", () => {
    delete process.env["TEST_PG_URL"];
    expect(testDatabaseBackend()).toBe("pglite");

    process.env["TEST_PG_URL"] = "";
    expect(testDatabaseBackend()).toBe("pglite");

    process.env["TEST_PG_URL"] = "postgres://cf_test@127.0.0.1:5433/postgres";
    expect(testDatabaseBackend()).toBe("server");
  });

  test("says an unreachable TEST_PG_URL is unreachable, rather than waiting out a connect timeout", async () => {
    // Port 1 on loopback: nothing listens there, so the refusal is immediate and
    // this costs no server. The name is what a lane reads when its server is down.
    await expect(
      probeServer({
        host: "127.0.0.1",
        port: 1,
        user: "cf_test",
        password: "",
        database: "postgres",
        ssl: false,
        max: 1,
      }),
    ).rejects.toThrow(/TEST_PG_URL set but unreachable/);
  });
});

describe("templateName", () => {
  const set = [m("0001_a", "create table a (x int);"), m("0002_b", "create table b (y int);")];

  test("is the same name for the same migrations, and a fresh one per migration set", () => {
    expect(templateName(set)).toBe(templateName(set));
    expect(templateName(set)).toMatch(/^cf_tpl_[0-9a-f]{12}$/);
    // Order is the migration order, not the caller's: the same set must not get
    // two templates because two callers listed it differently.
    expect(templateName([...set].reverse())).not.toBe(templateName(set));
    expect(templateName([...set, m("0003_c", "create table c (z int);")])).not.toBe(
      templateName(set),
    );
  });

  test("changes when a migration's SQL changes, and not when only its id is re-read", () => {
    // The falsifiable half of the name: same ids, different SQL is a different
    // set, because an edited migration is refused in place and must be applied
    // as a new one. A hash over the ids alone would call these the same template
    // and hand every test a stale schema.
    const edited = [
      m("0001_a", "create table a (x int, y int);"),
      m("0002_b", "create table b (y int);"),
    ];
    expect(templateName(edited)).not.toBe(templateName(set));

    // A migration set that differs only in whitespace is still a different set:
    // `migrate()` records the checksum, not the id.
    const respelled = [
      m("0001_a", "create table a (x int); "),
      m("0002_b", "create table b (y int);"),
    ];
    expect(templateName(respelled)).not.toBe(templateName(set));
  });
});

describe("processAlive", () => {
  test("is true for this process, and false for a pid that cannot exist", () => {
    expect(processAlive(process.pid)).toBe(true);
    // 2^22 is above Linux's default pid_max and above any macOS pid this host
    // has issued, so `kill(pid, 0)` reports ESRCH rather than EPERM.
    expect(processAlive(4_194_304)).toBe(false);
  });
});

describe("dropDatabase", () => {
  /**
   * A `run` that records the statements it was handed and then answers with
   * whatever `refuse` says about the one it is looking at.
   *
   * Injected, because this is the one part of the harness that a server cannot be
   * asked to produce on demand: the 42501 the fallback exists for comes from an
   * autovacuum worker inside a fresh clone, and provoking one takes superuser
   * rights this role does not have. What is under test is which statement a given
   * failure earns, and that is a question about the code, not about the server.
   */
  const recorder = (
    refuse: (statement: string) => unknown = () => undefined,
  ): { statements: string[]; run: (text: string) => Promise<unknown> } => {
    const statements: string[] = [];
    return {
      statements,
      run: async (text: string) => {
        statements.push(text);
        const outcome = refuse(text);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    };
  };

  /** A `pg` error as the wire delivers it: the message, and the code beside it. */
  const pgError = (message: string, code: string): Error =>
    Object.assign(new Error(message), { code });

  /**
   * What a call did, without deciding yet: `{ rejected: false }`, or the error it
   * rejected with. For the case where a retry could either add a statement or
   * swallow the error the caller was handed, and the statement count has to be the
   * assertion that fires first — a rejected promise cannot be inspected until it
   * settles, and by then a swallowed error is already gone.
   */
  const outcome = (work: Promise<unknown>): Promise<{ rejected: boolean; error?: unknown }> =>
    work.then(
      () => ({ rejected: false }),
      (error: unknown) => ({ rejected: true, error }),
    );

  const FORCE = 'drop database "cf_t_1_2_3" with (force)';
  const PLAIN = 'drop database "cf_t_1_2_3"';
  /** What a forced drop says when it may not signal a process in the target. */
  const mayNotTerminate = (): Error => pgError("permission denied to terminate process", "42501");
  /** And what a plain drop says when a session is still connected. */
  const inUse = (): Error => pgError("database is being accessed by other users", "55006");

  test("drops with FORCE alone when the forced drop is allowed", async () => {
    const { statements, run } = recorder();

    await dropDatabase(run, "cf_t_1_2_3");

    // One statement, and it is the forced one: the common case must not pay for
    // the fallback's existence.
    expect(statements).toEqual([FORCE]);
  });

  test("falls back to exactly one plain drop when the forced drop is refused with 42501", async () => {
    // The measured case: `cf_test` is not a superuser and is not in
    // `pg_signal_backend`, so an autovacuum worker inside a 2-second-old clone
    // makes the forced drop answer 42501 — and the plain drop behind it terminates
    // that worker itself, with no permission check. The order is the whole claim:
    // forced first, and plain only because of it.
    const { statements, run } = recorder((statement) =>
      statement === FORCE ? mayNotTerminate() : undefined,
    );

    await expect(dropDatabase(run, "cf_t_1_2_3")).resolves.toBeUndefined();

    expect(statements).toEqual([FORCE, PLAIN]);
  });

  test("rethrows any other refusal, rather than trying a second statement", async () => {
    // 55006 is the sweep's own neighbour, and the one a widened fallback would
    // swallow into a second drop that fails for the same reason. The same object,
    // not a like new one: a caller that cannot tell which database is still in use
    // has lost the error it was given.
    const held = inUse();
    const { statements, run } = recorder(() => held);

    await expect(dropDatabase(run, "cf_t_1_2_3")).rejects.toBe(held);

    expect(statements).toHaveLength(1);
  });

  test("reports a plain drop that fails too, and does not try a third statement", async () => {
    // A 42501 that the plain drop cannot fix — a session inside the clone that may
    // not be signalled — answers 55006 from `CountOtherDBBackends` after its own 5 s
    // wait. That is the honest failure, and it is the plain drop's error rather than
    // the forced one, because it is the statement that actually ran last.
    const refused = mayNotTerminate();
    const held = inUse();
    const { statements, run } = recorder((statement) => (statement === FORCE ? refused : held));

    const result = await outcome(dropDatabase(run, "cf_t_1_2_3"));

    // The count first, because that is the claim: two statements, never three. A
    // retry after a failed plain drop would be a loop, and a loop here is the
    // defect this guards rather than the error the caller is handed.
    expect(statements).toHaveLength(2);
    // And the error is the plain drop's own, by identity rather than by message:
    // `isGoneOrGoing` reads the code beside the message, so a re-wrapped error is a
    // different answer to a sweep deciding whether to forgive a row.
    expect(result.rejected).toBe(true);
    expect(result.error).toBe(held);
  });

  test("refuses a name it will not interpolate, before any statement runs", async () => {
    const { statements, run } = recorder();

    await expect(dropDatabase(run, "bad-name")).rejects.toThrow(/refusing an unsafe database name/);

    // Nothing reached the server: a name this harness would not put in a DROP is
    // refused by the same rule whether or not a fallback follows it.
    expect(statements).toEqual([]);
  });
});

describe("yarn test:pg-clean", () => {
  test("says so and drops nothing when TEST_PG_URL is unset", async () => {
    delete process.env["TEST_PG_URL"];
    const lines: string[] = [];
    await pgClean((line) => lines.push(line));
    expect(lines).toEqual([
      "TEST_PG_URL is not set — nothing to clean. Set it to the test server to drop its databases.",
    ]);
  });

  test("keeps the one-hour bound unless --all is given", async () => {
    process.env["TEST_PG_URL"] = "postgres://cf_test@127.0.0.1:5433/postgres";
    const asked: string[] = [];
    const drop = async (clones: "aged" | "none"): Promise<string[]> => {
      asked.push(clones);
      return [];
    };

    const bounded: string[] = [];
    await pgClean((line) => bounded.push(line), [], drop);
    const everything: string[] = [];
    await pgClean((line) => everything.push(line), ["--all"], drop);

    expect(asked).toEqual(["aged", "none"]);
    expect(bounded).toEqual([
      "Nothing to drop on that server.",
      "A database younger than an hour was left, if there was one: it may be a run in flight. `yarn test:pg-clean --all` drops those too.",
    ]);
    expect(everything).toEqual(["Nothing to drop on that server."]);
  });

  test("lists what it dropped", async () => {
    process.env["TEST_PG_URL"] = "postgres://cf_test@127.0.0.1:5433/postgres";
    const lines: string[] = [];
    await pgClean(
      (line) => lines.push(line),
      ["--all"],
      async () => ["cf_t_1_2_0", "cf_t_1_2_1"],
    );
    expect(lines).toEqual(["Dropped 2 database(s):\n  cf_t_1_2_0\n  cf_t_1_2_1"]);
  });
});

/**
 * A `pg.Client`-shaped fake: the first `query` is the scan and returns the rows
 * planted here; every later `query` is an untemplate or drop, answered by `refuse`.
 * Driven in-process because a foreign-owned 42501 cannot be produced on a role
 * without CREATEROLE, and the 42501 branch is a question about which row throws,
 * not about the server.
 */
type FakeRow = { datname: string; description: string | null };
function fakeSession(
  rows: FakeRow[],
  refuse: (text: string) => Error | undefined,
): { statements: string[]; query: (text: string) => Promise<unknown> } {
  const statements: string[] = [];
  let scanned = false;
  return {
    statements,
    query: async (text: string): Promise<unknown> => {
      statements.push(text);
      if (!scanned) {
        scanned = true;
        return { rows };
      }
      const refused = refuse(text);
      if (refused) throw refused;
      return { rows: [] };
    },
  };
}

/** A `pg` error carrying the code the wire would set. */
function pgError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("sweep", () => {
  test("skips a database whose name this harness did not build, and scans only this role's databases", async () => {
    const rows: FakeRow[] = [
      { datname: "cf_home", description: null },
      { datname: "cf_conc", description: null },
      { datname: `cf_keepme_${process.pid}`, description: null },
    ];
    const session = fakeSession(rows, () => undefined);

    const dropped = await sweep(session as unknown as pg.Client, "cf_tpl_dummy", "orphaned");

    expect(dropped).toEqual([]);
    const scan = session.statements[0]!;
    expect(scan).toContain("datdba");
    expect(scan).toContain("current_user");
    expect(
      session.statements.filter(
        (s) => s.startsWith("drop database") || s.startsWith("alter database"),
      ),
    ).toEqual([]);
  });

  test("survives a 42501 on one row and still visits the next", async () => {
    // "none" makes the clone eligible without the age/pid guards, so the
    // drop runs and the refused-then-plain pair both answer 42501.
    const epoch = Math.floor(Date.now() / 1000) - 4_000;
    const rows: FakeRow[] = [
      { datname: `cf_t_999999998_${epoch}_0`, description: null },
      { datname: `cf_t_999999998_${epoch}_1`, description: null },
    ];
    const session = fakeSession(rows, (text) =>
      text.startsWith("drop database")
        ? pgError("permission denied to terminate process", "42501")
        : undefined,
    );

    const dropped = await sweep(session as unknown as pg.Client, "cf_tpl_dummy", "none");

    expect(dropped).toEqual([]);
    const attempted = session.statements
      .filter((s) => s.startsWith("drop database"))
      .map((s) => s.match(/"(cf_t_\d+_\d+_\d+)"/)?.[1])
      .filter(Boolean) as string[];
    // Both rows were visited: each clone earned a forced and a plain drop.
    expect(new Set(attempted)).toEqual(
      new Set([`cf_t_999999998_${epoch}_0`, `cf_t_999999998_${epoch}_1`]),
    );
  });

  /** The clone names a sweep tried to drop, in order, once each. */
  function dropsOf(session: { statements: string[] }): string[] {
    const names = session.statements
      .filter((s) => s.startsWith("drop database"))
      .map((s) => s.match(/"(cf_t_\d+_\d+_\d+)"/)?.[1])
      .filter(Boolean) as string[];
    return [...new Set(names)];
  }

  // Three clones: one made a minute ago, and two made over an hour ago — one by
  // a pid that is gone and one by this process, which is as alive as a pid gets.
  function threeClones(): { young: string; oldDead: string; oldAlive: string; rows: FakeRow[] } {
    const now = Math.floor(Date.now() / 1000);
    const young = `cf_t_999999998_${now - 60}_0`;
    const oldDead = `cf_t_999999998_${now - 4_000}_0`;
    const oldAlive = `cf_t_${process.pid}_${now - 4_000}_0`;
    const rows = [young, oldDead, oldAlive].map((datname) => ({ datname, description: null }));
    return { young, oldDead, oldAlive, rows };
  }

  test("orphaned: takes only a clone an hour old whose pid is gone", async () => {
    const { oldDead, rows } = threeClones();
    const session = fakeSession(rows, () => undefined);

    const dropped = await sweep(session as unknown as pg.Client, "cf_tpl_dummy", "orphaned");

    expect(dropped).toEqual([oldDead]);
    expect(dropsOf(session)).toEqual([oldDead]);
  });

  test("aged: takes every clone an hour old, whatever its pid, and leaves a younger one", async () => {
    const { oldDead, oldAlive, rows } = threeClones();
    const session = fakeSession(rows, () => undefined);

    const dropped = await sweep(session as unknown as pg.Client, "cf_tpl_dummy", "aged");

    expect(dropped).toEqual([oldDead, oldAlive]);
    expect(dropsOf(session)).toEqual([oldDead, oldAlive]);
  });

  test("none: takes a clone younger than an hour too", async () => {
    const { young, oldDead, oldAlive, rows } = threeClones();
    const session = fakeSession(rows, () => undefined);

    const dropped = await sweep(session as unknown as pg.Client, "cf_tpl_dummy", "none");

    expect(dropped).toEqual([young, oldDead, oldAlive]);
  });
});
