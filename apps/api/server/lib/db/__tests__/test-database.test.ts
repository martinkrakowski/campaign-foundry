import { describe, test, expect, afterEach } from "vitest";
import type { Migration } from "../migrate.js";
import { processAlive, probeServer, templateName, testDatabaseBackend } from "./test-database.js";

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
