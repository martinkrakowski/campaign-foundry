import { describe, test, expect, afterEach } from "vitest";
import { betterAuth } from "better-auth";
import { authOptions } from "../../auth/options.js";
import { loadMigrations, migrate, type Migration } from "../migrate.js";
import { pgClient } from "../pg-client.js";
import { authDatabase, emptyDatabase, migratedDatabase } from "./pglite-client.js";
import {
  cloneConfig,
  dropHarnessDatabase,
  dropOrphans,
  ensureTemplate,
  maintenanceConfig,
  maintenanceSession,
  testDatabaseBackend,
  templateName,
} from "./test-database.js";

/**
 * The server-only half of the test-database harness (D186).
 *
 * Every test here skips itself unless `TEST_PG_URL` is set, and is run by CI's
 * server step against that job's own `postgres:17` service. The suite's default
 * mode — `TEST_PG_URL` unset, every database on PGlite — is what the rest of the
 * suite proves, and `test-database.test.ts` covers the harness's own parts that
 * need no server.
 */

const server = testDatabaseBackend() === "server";
const m = (id: string, sql: string): Migration => ({ id, sql });

/** A pid that cannot be alive: above any pid Linux or macOS issues by default. */
const DEAD_PID = 4_194_304;

const cloneName = (pid: number, ageSeconds: number, counter = 0) =>
  `cf_t_${pid}_${Math.floor(Date.now() / 1000) - ageSeconds}_${counter}`;

async function createDatabase(name: string): Promise<void> {
  const session = await maintenanceSession();
  try {
    await session.query(`create database "${name}"`);
  } finally {
    await session.end();
  }
}

async function commentOn(name: string, text: string): Promise<void> {
  const session = await maintenanceSession();
  try {
    await session.query(`comment on database "${name}" is '${text}'`);
  } finally {
    await session.end();
  }
}

/** What a finished build leaves: the flag, and then the epoch. */
async function markAsTemplate(name: string): Promise<void> {
  const session = await maintenanceSession();
  try {
    await session.query(`alter database "${name}" is_template true`);
  } finally {
    await session.end();
  }
}

async function commentOf(name: string): Promise<string | null> {
  const session = await maintenanceSession();
  try {
    const { rows } = await session.query<{ description: string | null }>(
      "select s.description from pg_database d left join pg_shdescription s" +
        " on s.objoid = d.oid and s.classoid = 'pg_database'::regclass where d.datname = $1",
      [name],
    );
    return rows[0]?.description ?? null;
  } finally {
    await session.end();
  }
}

async function names(): Promise<string[]> {
  const session = await maintenanceSession();
  try {
    const { rows } = await session.query<{ datname: string }>(
      "select datname from pg_database where datname like 'cf\\_%'",
    );
    return rows.map((r) => r.datname);
  } finally {
    await session.end();
  }
}

const created: string[] = [];

afterEach(async () => {
  for (const name of created.splice(0)) {
    // Through the harness's own drop, which takes the template flag off first —
    // a test that planted a template (a build this file makes, or a stale one)
    // cannot be cleaned up any other way. Only "already gone" is forgiven: a
    // cleanup that took the fixture first is this file's own doing, while a
    // REFUSED drop is the bug an earlier blanket `.catch()` here was hiding, and
    // it has to fail the run that hit it.
    await dropHarnessDatabase(name).catch((error: unknown) => {
      if ((error as { code?: string }).code !== "3D000") throw error;
    });
  }
});

describe.skipIf(!server)("the template (D186)", () => {
  test("two concurrent builds make exactly one template", async () => {
    const migrations = await loadMigrations();
    const name = templateName(migrations);
    // The advisory lock is what makes this exactly one: the loser's build finds
    // the winner's database already marked a template and stops.
    await Promise.all([ensureTemplate(migrations), ensureTemplate(migrations)]);

    const session = await maintenanceSession();
    try {
      const { rows } = await session.query<{ datname: string; datistemplate: boolean }>(
        "select datname, datistemplate from pg_database where datname like 'cf\\_tpl\\_%'",
      );
      // Exactly one database for THIS migration set, and it is a template. Not
      // one template on the whole server: a second run of the suite, a second
      // worktree, or a branch whose migrations hash elsewhere all leave templates
      // here that are none of this test's business, and asserting they are absent
      // makes the test fail on the second run of a server rather than on the bug.
      expect(rows.filter((r) => r.datname === name)).toEqual([
        { datname: name, datistemplate: true },
      ]);
    } finally {
      await session.end();
    }
  });

  test("a build killed between the flag and the comment is dated, not read as ancient", async () => {
    const migrations = [m("0001_stamped", "create table stamped (x int);")];
    const name = templateName(migrations);
    // Planted rather than built, because the point is a build this process knows
    // nothing about: a build killed between `ALTER … IS_TEMPLATE true` and its
    // `COMMENT` leaves a finished template with nothing to date it, and the
    // cleanup rule for an undated template is "older than a day" — true of it at
    // once, so the next worker's sweep would take it out from under every test
    // copying it. Being this run's current template is all that saves it, and
    // only until the next run, when it is not.
    await createDatabase(name);
    created.push(name);
    await markAsTemplate(name);
    expect(await commentOf(name)).toBeNull();

    expect(await ensureTemplate(migrations)).toBe(name);

    // A real epoch, not merely something: `Number(null)` is 0, so an undated
    // template fails this as "expected 0 to be greater than 0".
    expect(Number(await commentOf(name))).toBeGreaterThan(0);
  });

  test("the template is built once per process, not once per clone", async () => {
    const migrations = [m("0001_once", "create table once_only (x int);")];
    const name = await ensureTemplate(migrations);
    created.push(name);

    // Gone from the server, and answered from what this process built all the
    // same: the build is a global advisory lock, a pg_database scan and an
    // orphan sweep on a session of its own, and the second clone of a suite has
    // no reason to pay for any of it. A clone that finds the template missing
    // is the one thing that undoes this, and it rebuilds.
    await dropHarnessDatabase(name);
    expect(await names()).not.toContain(name);

    expect(await ensureTemplate(migrations)).toBe(name);
    expect(await names()).not.toContain(name);
  });

  test("a build killed before it was marked a template is dropped and built again", async () => {
    // A synthetic migration set, so this template is one nothing else touches.
    // The shared one is a template the rest of this suite is cloning from while
    // this file runs, and dropping it out from under them is a race, not a test.
    const migrations = [m("0001_only", "create table only_this (x int);")];
    const name = templateName(migrations);
    // Exactly what a killed build leaves behind: the database exists, and it is
    // not a template. Reusing it would clone an empty schema into every test.
    await createDatabase(name);
    created.push(name);

    expect(await ensureTemplate(migrations)).toBe(name);

    const session = await maintenanceSession();
    try {
      const { rows } = await session.query<{ datistemplate: boolean }>(
        "select datistemplate from pg_database where datname = $1",
        [name],
      );
      expect(rows).toEqual([{ datistemplate: true }]);
      // And it is a real migration run, not just a flag: the table is in it.
      const build = pgClient(cloneConfig(name));
      try {
        await build.query("insert into only_this values (1)");
      } finally {
        await build.end();
      }
    } finally {
      await session.end();
    }
  });
});

describe.skipIf(!server)("migrated and empty databases (D186)", () => {
  test("a migrated database has every migration applied, and an empty one has none", async () => {
    const migrated = await migratedDatabase();
    const empty = await emptyDatabase();
    try {
      const applied = await migrated.query<{ id: string }>(
        "select id from schema_migrations order by id",
      );
      expect(applied.rows.map((r) => r.id)).toEqual((await loadMigrations()).map((x) => x.id));
      const none = await empty.query<{ t: string | null }>(
        "select to_regclass('schema_migrations')::text as t",
      );
      expect(none.rows[0]!.t).toBeNull();
    } finally {
      await migrated.end();
      await empty.end();
    }
  });

  test("a clone whose template was cleaned up underneath it rebuilds and copies", async () => {
    // What makes remembering the template name safe. Without forgetting it on
    // 3D000, the second `CREATE … TEMPLATE` would fail the same way and the run
    // would be over: the name this process remembers is exactly the one that
    // stopped existing.
    const name = await ensureTemplate();
    await dropHarnessDatabase(name);
    expect(await names()).not.toContain(name);

    const db = await migratedDatabase();
    try {
      const applied = await db.query<{ id: string }>(
        "select id from schema_migrations order by id",
      );
      expect(applied.rows.map((r) => r.id)).toEqual((await loadMigrations()).map((x) => x.id));
    } finally {
      await db.end();
    }
    expect(await names()).toContain(name);
  });

  test("end() drops the database it was opened against", async () => {
    const before = await names();
    const db = await emptyDatabase();
    const [name] = (await names()).filter((n) => !before.includes(n));
    expect(name).toMatch(new RegExp(`^cf_t_${process.pid}_`));

    await db.end();

    expect(await names()).not.toContain(name);
  });
});

describe.skipIf(!server)("orphan cleanup (D186)", () => {
  test("drops an old database whose pid is gone, and keeps a live one and a young one", async () => {
    const old = cloneName(DEAD_PID, 7_200);
    const live = cloneName(process.pid, 7_200, 1);
    const young = cloneName(DEAD_PID, 60, 2);
    // A template a day old, for migrations this run does not ship. Marked as a
    // template, because a template is what the harness builds and what cleanup
    // has to be able to drop — a plain database with the same name would pass
    // this test while the real case went on failing, because Postgres refuses
    // to drop a template at all and `with (force)` does not override that.
    const stale = `cf_tpl_${"0".repeat(12)}`;
    for (const name of [old, live, young, stale]) {
      await createDatabase(name);
      created.push(name);
    }
    await markAsTemplate(stale);
    await commentOn(stale, `${Math.floor(Date.now() / 1000) - 90_000}`);

    // The sweep itself, not the template step that carries it: this is a test of
    // the bounds, and the template step only runs them once per process now.
    await dropOrphans(templateName(await loadMigrations()));

    const left = await names();
    expect(left).not.toContain(old);
    expect(left).toContain(live);
    expect(left).toContain(young);
    expect(left).not.toContain(stale);
  });

  test("the current template is never dropped by its own cleanup", async () => {
    const name = await ensureTemplate();
    expect(await dropOrphans(name)).not.toContain(name);
    expect(await names()).toContain(name);
  });
});

describe.skipIf(!server)("authDatabase (D186)", () => {
  test("gives Better Auth an empty database and the same pool to query through", async () => {
    const { pool, sql, end } = await authDatabase();
    try {
      // Each site migrates what it finds, so this database must arrive empty.
      const before = await sql.query<{ t: string | null }>(
        `select to_regclass('"user"')::text as t`,
      );
      expect(before.rows[0]!.t).toBeNull();

      await migrate(sql, await loadMigrations());
      const sent: string[] = [];
      const instance = betterAuth(
        authOptions({
          database: pool,
          secret: "a".repeat(32),
          baseURL: "http://127.0.0.1:3001",
          mailer: { send: async ({ to }) => void sent.push(to) },
        }),
      );
      await instance.api.signInMagicLink({
        body: { email: "person@example.com" },
        headers: new Headers(),
      });

      // `sql` is the SAME pool Better Auth wrote through, which is the proof
      // `schema-agreement.test.ts` needs from the PGlite side too. Signing in by
      // magic link writes the verification row, not a user — the user is
      // created when the link is followed.
      const rows = await sql.query<{ identifier: string; value: string }>(
        "select identifier, value from verification",
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]!.identifier).toEqual(expect.any(String));
      expect(rows.rows[0]!.value).toContain("person@example.com");
      expect(sent).toEqual(["person@example.com"]);
    } finally {
      await end();
    }
  });
});

describe.skipIf(!server)("the maintenance connection", () => {
  test("names the database TEST_PG_URL names, over loopback and with no CA", () => {
    const config = maintenanceConfig();
    expect(config.database).toBe(
      decodeURIComponent(new URL(process.env["TEST_PG_URL"]!).pathname.slice(1)),
    );
    expect(config.ssl).toBe(false);
  });

  test("refuses a remote TEST_PG_URL, so the harness can never reach a hosted database", () => {
    const saved = process.env["TEST_PG_URL"];
    process.env["TEST_PG_URL"] = "postgres://me@db.example.com:5432/cf";
    try {
      expect(() => maintenanceConfig()).toThrow(/DATABASE_CA_PATH is not set/);
    } finally {
      if (saved === undefined) delete process.env["TEST_PG_URL"];
      else process.env["TEST_PG_URL"] = saved;
    }
  });

  test("a synthetic migration set still gets a well-formed template name", () => {
    expect(templateName([m("0001_x", "select 1;")])).toMatch(/^cf_tpl_[0-9a-f]{12}$/);
  });
});
