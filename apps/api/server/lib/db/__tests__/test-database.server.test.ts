import { describe, test, expect, afterEach } from "vitest";
import { betterAuth } from "better-auth";
import { authOptions } from "../../auth/options.js";
import { loadMigrations, migrate, type Migration } from "../migrate.js";
import { pgClient } from "../pg-client.js";
import { authDatabase, emptyDatabase, migratedDatabase } from "./pglite-client.js";
import {
  cloneConfig,
  drop,
  dropEveryTestDatabase,
  dropHarnessDatabase,
  dropOrphans,
  ensureTemplate,
  maintenanceConfig,
  maintenanceSession,
  migratedFromTemplate,
  testDatabaseBackend,
  templateName,
  TEMPLATE_LOCK,
  whileBuilding,
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

/** Whether a migration in some set has been applied to a named database. */
async function hasTable(name: string, table: string): Promise<boolean> {
  const client = pgClient(cloneConfig(name));
  try {
    const { rows } = await client.query<{ t: string | null }>("select to_regclass($1)::text as t", [
      `public.${table}`,
    ]);
    return rows[0]!.t !== null;
  } finally {
    await client.end();
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
    // A synthetic set, so this build is one nothing else on the server is
    // cloning from and the afterEach below can take it away again.
    const migrations = [m("0001_twice", "create table twice_only (x int);")];
    const name = templateName(migrations);
    created.push(name);
    // Two sessions on the lock, not two calls answered from one map: the second
    // caller here is a real build, and the first to be given the lock is the
    // one that creates the database. `ensureTemplate` alone would not do —
    // within a process the second call for a name is handed the first call's
    // in-flight promise and never reaches the lock at all, so that pair proves
    // the cache rather than the lock.
    const [built, waited] = await Promise.all([
      whileBuilding((build) => build(name, migrations)),
      ensureTemplate(migrations),
    ]);
    expect(built).toBe(name);
    expect(waited).toBe(name);

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
      // The filter is what the synthetic set earns its keep for — the other
      // tests in this file build templates too.
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
    created.push(name);
    // Planted rather than built, because the point is a template this process
    // knows nothing about: a build killed between `ALTER … IS_TEMPLATE true` and
    // its `COMMENT` leaves a finished template with nothing to date it. The
    // cleanup rule for an undated template is "older than a day", which is true of
    // it at once, so any other worker's sweep on this shared server takes it —
    // which is why the plant and the adoption happen under one lock, exactly as a
    // build holds that lock across its own two statements.
    await whileBuilding(async (build) => {
      await createDatabase(name);
      await markAsTemplate(name);
      return build(name, migrations);
    });
    expect(await ensureTemplate(migrations)).toBe(name);

    // Dated, and still the database that was planted: no migration ran, so the
    // build adopted it rather than building over it.
    expect(Number(await commentOf(name))).toBeGreaterThan(0);
    expect(await hasTable(name, "stamped")).toBe(false);
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
    // Planted under the lock, since an undated `cf_tpl_*` is stale to every other
    // worker's sweep from the moment it exists — including the window between
    // the two statements here.
    await whileBuilding(async () => createDatabase(name));
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
    // A synthetic set, so the template this drops is one nothing else is using.
    // The shared template is dropped by no test ever: fifty workers clone from it
    // at once, and a test that took it away from them would be a fault in the
    // suite, not evidence about the harness.
    const migrations = [m("0001_raced", "create table raced (x int);")];
    const template = await ensureTemplate(migrations);
    created.push(template);
    // What a sweep that won the race leaves behind: a name this process
    // remembers, and a server that no longer has it. Without forgetting the name
    // on 3D000, the retry would be handed the same missing template and the run
    // would be over.
    await dropHarnessDatabase(template);
    expect(await names()).not.toContain(template);

    const db = await migratedFromTemplate(template, migrations);
    try {
      const applied = await db.query<{ id: string }>(
        "select id from schema_migrations order by id",
      );
      expect(applied.rows.map((r) => r.id)).toEqual(migrations.map((x) => x.id));
    } finally {
      await db.end();
    }
    expect(await names()).toContain(template);
  });

  test("end() drops the database it was opened against", async () => {
    // Scoped to this process. The suite runs many workers against one server,
    // and every one of them is creating and dropping `cf_t_*` at the same time,
    // so a difference over the whole list is not evidence of anything — the
    // first name that appeared is as likely to be a worker's as this test's.
    const mine = (list: string[]) => list.filter((n) => n.startsWith(`cf_t_${process.pid}_`));
    const before = mine(await names());
    const db = await emptyDatabase();
    const [name] = mine(await names()).filter((n) => !before.includes(n));
    expect(name).toMatch(new RegExp(`^cf_t_${process.pid}_\\d+_\\d+$`));

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
    // Every one of these is planted under the build lock, which is the only
    // thing a foreign worker's sweep also takes. `stale` is in particular a
    // fixture any other worker's sweep may take, from three statements here:
    // it is stale the moment `CREATE` returns (no comment reads as built at
    // zero) and stale again once the comment dates it 90,000 s back. Planted
    // outside the lock, it loses all three ways — its own `ALTER`/`COMMENT`
    // answer 3D000 once the sweep has dropped it, answer 55000 while the drop
    // is still in flight, and an `ALTER … IS_TEMPLATE true` landing between a
    // sweep's untemplate and its drop answers 42809 and fails a worker in
    // another file.
    await whileBuilding(async () => {
      for (const name of [old, live, young, stale]) {
        await createDatabase(name);
        created.push(name);
      }
      await markAsTemplate(stale);
      await commentOn(stale, `${Math.floor(Date.now() / 1000) - 90_000}`);
    });

    // The sweep itself, not the template step that carries it: this is a test of
    // the bounds, and the template step only runs them once per process now.
    // Outside the lock above, and so racing every worker on the server — which
    // is why its assertions are about what survives, not about who did it.
    await dropOrphans(templateName(await loadMigrations()));

    const left = await names();
    expect(left).not.toContain(old);
    expect(left).toContain(live);
    expect(left).toContain(young);
    expect(left).not.toContain(stale);
  });

  test("a sweep waits for a build in flight instead of racing it", async () => {
    // The sweep the on-demand script runs, beside a build the way a run's own
    // build is. A template is undated from `CREATE` until its `COMMENT`, and an
    // undated template reads as built at zero — so a sweep that does not take
    // the build lock reads a half-built template as ancient and drops it. The
    // `afterEach` here plants the fixture, which makes it a template a day old.
    const stale = `cf_tpl_${"1".repeat(12)}`;
    const current = templateName(await loadMigrations());

    const building = await maintenanceSession();
    await building.query("select pg_advisory_lock($1)", [TEMPLATE_LOCK]);
    try {
      // Queued before the fixture exists, so it is the first waiter on the lock
      // and this test is measuring the wait rather than the queue order.
      let swept = false;
      const sweeping = dropOrphans(current).then((dropped) => {
        swept = true;
        return dropped;
      });
      // Planted under the lock this test holds, which is the one window a
      // foreign worker's sweep cannot get into. This fixture is stale to every
      // sweep on the server, not only this test's, and a plant outside the lock
      // is a coin toss with all of them.
      await createDatabase(stale);
      created.push(stale);
      await markAsTemplate(stale);
      await commentOn(stale, `${Math.floor(Date.now() / 1000) - 90_000}`);

      // Long enough for an unlocked sweep to have finished and dropped it.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(swept).toBe(false);
      expect(await names()).toContain(stale);

      await building.query("select pg_advisory_unlock($1)", [TEMPLATE_LOCK]);
      expect(await sweeping).toContain(stale);
    } finally {
      await building.query("select pg_advisory_unlock($1)", [TEMPLATE_LOCK]).catch(() => undefined);
      await building.end();
    }
    expect(await names()).not.toContain(stale);
  });

  test("the current template is never dropped by its own cleanup", async () => {
    const name = await ensureTemplate();
    expect(await dropOrphans(name)).not.toContain(name);
    expect(await names()).toContain(name);
  });

  test("dropEveryTestDatabase leaves a same-role cf_ name this harness did not build", async () => {
    // `cf_test` owns it, so the sweep's owner filter includes it — but its name
    // matches neither clone nor template pattern, so the name guard skips it. A
    // foreign-owner case cannot be planted here (`cf_test` lacks CREATEROLE);
    // that path is covered only by the server-free fake in `test-database.test.ts`.
    //
    // `--every-clone` drops every cf_t_* the role owns, so this is run against the
    // isolated CI postgres and only locally when the host's lane set is clear.
    const name = `cf_keepme_${process.pid}`;
    await createDatabase(name);
    try {
      await dropEveryTestDatabase();
      expect(await names()).toContain(name);
    } finally {
      await drop(name).catch((error: unknown) => {
        if ((error as { code?: string }).code !== "3D000") throw error;
      });
    }
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
      // Named for the variable the reader set, not the one `databaseConfig` was
      // given: a message about `DATABASE_CA_PATH` here sends somebody to change
      // the application's database to fix a test server.
      expect(() => maintenanceConfig()).toThrow(
        /TEST_PG_URL names a remote database, and the test harness only reaches a local test server/,
      );
    } finally {
      if (saved === undefined) delete process.env["TEST_PG_URL"];
      else process.env["TEST_PG_URL"] = saved;
    }
  });

  test("names TEST_PG_URL when it is not a URL at all", () => {
    const saved = process.env["TEST_PG_URL"];
    process.env["TEST_PG_URL"] = "not a url";
    try {
      expect(() => maintenanceConfig()).toThrow(/^TEST_PG_URL is not a URL\.$/);
    } finally {
      if (saved === undefined) delete process.env["TEST_PG_URL"];
      else process.env["TEST_PG_URL"] = saved;
    }
  });

  test("a synthetic migration set still gets a well-formed template name", () => {
    expect(templateName([m("0001_x", "select 1;")])).toMatch(/^cf_tpl_[0-9a-f]{12}$/);
  });
});
