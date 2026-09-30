import { describe, test, expect, afterEach } from "vitest";
import { betterAuth } from "better-auth";
import { authOptions } from "../../auth/options.js";
import { LogMailer } from "../../auth/log-mailer.js";
import { loadMigrations, migrate, type Migration } from "../migrate.js";
import { authDatabase, emptyDatabase, migratedDatabase } from "./pglite-client.js";
import {
  drop,
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
    await drop(name).catch(() => undefined);
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
      expect(rows.filter((r) => r.datistemplate)).toEqual([{ datname: name, datistemplate: true }]);
    } finally {
      await session.end();
    }
  });

  test("a build killed before it was marked a template is dropped and built again", async () => {
    const migrations = await loadMigrations();
    const name = templateName(migrations);
    // Exactly what a killed build leaves behind: the database exists, and it is
    // not a template. Reusing it would clone an empty schema into every test.
    await drop(name).catch(() => undefined);
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
    // A template a day old, for migrations this run does not ship.
    const stale = `cf_tpl_${"0".repeat(12)}`;
    for (const name of [old, live, young, stale]) {
      await createDatabase(name);
      created.push(name);
    }
    await commentOn(stale, `${Math.floor(Date.now() / 1000) - 90_000}`);

    await ensureTemplate();

    const left = await names();
    expect(left).not.toContain(old);
    expect(left).toContain(live);
    expect(left).toContain(young);
    expect(left).not.toContain(stale);
  });

  test("the current template is never dropped by its own cleanup", async () => {
    const name = await ensureTemplate();
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
      const instance = betterAuth(
        authOptions({
          database: pool,
          secret: "a".repeat(32),
          baseURL: "http://127.0.0.1:3001",
          mailer: new LogMailer(),
        }),
      );
      await instance.api.signInMagicLink({
        body: { email: "person@example.com" },
        headers: new Headers(),
      });

      // `sql` is the SAME pool Better Auth wrote through, which is the proof
      // `schema-agreement.test.ts` needs from the PGlite side too.
      const rows = await sql.query<{ email: string }>(`select email from "user"`);
      expect(rows.rows.map((r) => r.email)).toEqual(["person@example.com"]);
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
