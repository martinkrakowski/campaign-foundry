import { createHash } from "node:crypto";
import pg from "pg";
import { databaseConfig, type DatabaseConfig } from "../database-config.js";
import { checksum, loadMigrations, migrate, type Migration } from "../migrate.js";
import { pgClient, poolOptions, type PgPool } from "../pg-client.js";
import type { SqlClient } from "../sql-client.js";

/**
 * The real-Postgres half of the database test harness (D186), selected by
 * `TEST_PG_URL`.
 *
 * Every database test starts a fresh PGlite — a real Postgres compiled to
 * WebAssembly, in process. That costs almost nothing on a fast machine and
 * 5.2–6.5 s per start on an older one, where it is the whole reason the gate
 * cannot pass. When `TEST_PG_URL` names a server, this module builds ONE
 * migrated template database on it and hands each test a `CREATE DATABASE …
 * TEMPLATE` copy of that: 110 ms, against that same host's 5.2 s PGlite start.
 *
 * A separate module from `pglite-client.ts` so the import graph stays one way:
 * that file is the PGlite primitive and the suite's entry point, and it
 * dispatches into this one. Nothing here imports it. Everything here is
 * therefore only true of a real server — where the staging database is never a
 * test target, and `TEST_DATABASE_URL` (the CI concurrency proofs) keeps its own
 * separate meaning.
 */

/** The one environment read in the harness. Unset or empty: PGlite, exactly as before. */
export function testDatabaseBackend(): "server" | "pglite" {
  return process.env["TEST_PG_URL"] ? "server" : "pglite";
}

/**
 * A probe's own connect timeout, well under `pg-client.ts`'s `CONNECT_TIMEOUT_MS`
 * (10 s): a set-but-unreachable `TEST_PG_URL` must say so in seconds, once per
 * test file, not once per test.
 */
const PROBE_TIMEOUT_MS = 2_000;

/** One template per migration set: `cf_tpl_` plus a hash of that set. */
const TEMPLATE_PREFIX = "cf_tpl_";
const TEMPLATE_HASH_LENGTH = 12;

/** A test's own database: who made it, roughly when, and which of theirs it is. */
const CLONE_PREFIX = "cf_t_";

/**
 * The advisory lock that serialises everything that creates, dates or drops a
 * harness template. Any fixed key will do, provided every process uses the same
 * one — and it must NOT be `migrate.ts`'s `MIGRATION_LOCK` (7_210_431), which is
 * transaction-level and lives inside the template's own migration.
 *
 * A sweep takes it as well as a build. That is the whole point of it: a template
 * is undated from `CREATE` until its `COMMENT`, and an undated template reads as
 * built at zero, so a sweep that ran beside a build would read a half-built
 * template as ancient and drop it. Waiting is the correct answer for a sweep
 * that arrives mid-build — a run in flight finishes in seconds, and a person who
 * ran `yarn test:pg-clean` at the wrong moment gets a wait rather than a
 * casualty.
 */
export const TEMPLATE_LOCK = 424_242;

/** How old a `cf_t_*` database must be before cleanup will even consider it. */
const ORPHAN_MAX_AGE_S = 3_600;

/** How long a superseded `cf_tpl_*` template lives before cleanup drops it. */
const STALE_TEMPLATE_MAX_AGE_S = 86_400;

/** Epoch seconds — the unit both a clone's name and a template's comment record. */
function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Per-process counter, so two databases built in the same second still differ. */
let sequence = 0;

function nextCloneName(): string {
  return `${CLONE_PREFIX}${process.pid}_${epochSeconds()}_${sequence++}`;
}

/** `cf_t_<pid>_<epoch>_<counter>`, or undefined for anything this harness did not name. */
const CLONE_NAME = /^cf_t_(\d+)_(\d+)_(\d+)$/;

/** A template name, and only one this harness built — cleanup drops nothing else. */
const TEMPLATE_NAME = /^cf_tpl_[0-9a-f]{12}$/;

/**
 * The template's name: the identity of the migration set, and nothing else.
 *
 * The hash covers each migration's id AND its SQL's checksum — the same pair
 * `schema_migrations` records, and the reason an edited migration (which
 * `migrate()` refuses in place) is a different set, not a different version of
 * this one. Pure, and the only part of the server path a test can pin without a
 * server.
 */
export function templateName(migrations: readonly Migration[]): string {
  const shape = migrations.map((m) => ({ id: m.id, checksum: checksum(m.sql) }));
  return `${TEMPLATE_PREFIX}${createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, TEMPLATE_HASH_LENGTH)}`;
}

/** A database name this harness may interpolate into DDL. */
function identifier(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`refusing an unsafe database name: ${name}`);
  return `"${name}"`;
}

/**
 * The maintenance database `TEST_PG_URL` names: the one every test server
 * connects to, and the only one `CREATE DATABASE` may be run from.
 *
 * `readCa` throws because it is never reached — a loopback test server is
 * reached over plain TCP, and `databaseConfig` calls this only for a CA path. A
 * REMOTE `TEST_PG_URL` is refused by `databaseConfig` itself, which is the point:
 * the harness must never be pointed at a hosted database.
 *
 * What it says when it refuses is re-pointed, because it can only name the
 * settings it was given: `DATABASE_URL` and `DATABASE_CA_PATH`, which the
 * harness never reads. Told to fix those, a reader would go and change the
 * application's database to fix a test server — and there is no CA setting here
 * to point at anything, so a remote host is refused outright rather than with
 * advice about certificates.
 */
export function maintenanceConfig(): DatabaseConfig {
  let config: DatabaseConfig;
  try {
    config = databaseConfig({ url: process.env["TEST_PG_URL"] }, () => {
      throw new Error("a local TEST_PG_URL needs no CA");
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      REMOTE_HOST.test(message)
        ? "TEST_PG_URL names a remote database, and the test harness only reaches a local test server."
        : message.replaceAll("DATABASE_URL", "TEST_PG_URL"),
      { cause: error },
    );
  }
  return config;
}

/** `databaseConfig`'s own way of saying the URL named a host it will not reach. */
const REMOTE_HOST = /^DATABASE_CA_PATH is not set/;

/** The same server, pointed at one named database, over one connection. */
export function cloneConfig(database: string): DatabaseConfig {
  return { ...maintenanceConfig(), database, max: 1 };
}

/**
 * Connect once and prove the server is there, naming the variable when it is
 * not.
 */
export async function probeServer(config: DatabaseConfig = maintenanceConfig()): Promise<void> {
  const client = new pg.Client({
    ...poolOptions(config),
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
  });
  try {
    await client.connect();
    await client.query("select 1");
  } catch (error) {
    throw new Error(
      `TEST_PG_URL set but unreachable (${error instanceof Error ? error.message : String(error)}) — ` +
        "unset it to run the suite on PGlite, or start the test server it names",
      { cause: error },
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

const probes = new Map<string, Promise<void>>();

/**
 * The first use of the server path in a test file probes; later uses in that
 * file reuse the answer, so a server that is down is reported once rather than
 * on every test. Keyed by the server probed, so pointing the harness somewhere
 * else earns its own verdict rather than inheriting one.
 *
 * Once per FILE, not once per process: vitest runs files in isolated forks
 * (`isolate` defaults to true and this config does not override it), so this map
 * starts empty in each one. An unreachable `TEST_PG_URL` costs two seconds per
 * file that reaches the server — which is seconds, not the ten a connect timeout
 * would cost per test.
 */
export function requireServerReachable(
  config: DatabaseConfig = maintenanceConfig(),
): Promise<void> {
  const key = `${config.host}:${config.port}/${config.user}/${config.database}`;
  const existing = probes.get(key);
  if (existing) return existing;
  const attempt = probeServer(config);
  probes.set(key, attempt);
  return attempt;
}

/**
 * One session to the maintenance database. A bare `pg.Client`, not a pool: an
 * advisory lock is held by a SESSION, so every statement that lock guards has to
 * arrive on the connection that took it.
 *
 * `CREATE`/`DROP`/`ALTER DATABASE` also cannot run inside a transaction, which
 * this is not.
 */
export async function maintenanceSession(): Promise<pg.Client> {
  const client = new pg.Client(poolOptions(maintenanceConfig()));
  await client.connect();
  return client;
}

/** One statement on its own maintenance session, then closed. */
async function maintenanceStatement(text: string): Promise<void> {
  const session = await maintenanceSession();
  try {
    await session.query(text);
  } finally {
    await session.end();
  }
}

/** A process is alive if its pid is; `EPERM` means it exists under another user, which still counts. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Drop what a killed run left behind, before this run adds to its own pile.
 *
 * A `cf_t_*` database is a candidate only once it is more than an hour old AND
 * its pid is gone. The age guard is what makes the pid check safe to read as an
 * answer — a recycled pid, or a host reboot, must not orphan a live run's
 * database mid-test — and the pid check is what stops that age guard from
 * leaving every hour-old run's databases to accumulate. A `cf_tpl_*` template
 * other than the current one is dropped a day after it was built, which is how a
 * template for migrations this branch no longer ships expires.
 */
export async function dropOrphans(currentTemplate: string): Promise<string[]> {
  return dropHarnessDatabases(currentTemplate, false);
}

/**
 * Every `cf_t_*` the server holds, and every stale `cf_tpl_*` — what
 * `yarn test:pg-clean` runs when automatic cleanup's bounds are the wrong
 * bounds, because a run was killed hard enough to leave a database younger than
 * an hour and somebody has said out loud that nothing is using that server.
 */
export async function dropEveryTestDatabase(): Promise<string[]> {
  return dropHarnessDatabases("", true);
}

/**
 * Take the template flag off, which is the only way a template can be dropped at
 * all: `with (force)` overrides the connected-sessions check and nothing else, so
 * `drop database` on a `datistemplate` database is refused (42809) whether
 * anything is connected to it or not.
 */
async function untemplate(session: pg.Client, name: string): Promise<void> {
  await session.query(`alter database ${identifier(name)} is_template false`);
}

/**
 * `everyClone` is the difference between the two callers: automatic cleanup
 * respects the age and pid bounds below, because it runs unattended against a
 * server other runs may be using, and the on-demand script does not.
 *
 * A sweep that is not part of a build takes `TEMPLATE_LOCK` first, so it cannot
 * run beside a build and read its half-written template as stale. The one that
 * IS part of a build arrives with the lock already held, on the session below —
 * which is why this takes the session rather than opening one: taking a
 * session-level advisory lock a second time on another session is a deadlock,
 * not a no-op.
 */
async function dropHarnessDatabases(
  currentTemplate: string,
  everyClone: boolean,
): Promise<string[]> {
  const session = await maintenanceSession();
  try {
    await session.query("select pg_advisory_lock($1)", [TEMPLATE_LOCK]);
    return await sweep(session, currentTemplate, everyClone);
  } finally {
    await session.query("select pg_advisory_unlock($1)", [TEMPLATE_LOCK]).catch(() => undefined);
    await session.end();
  }
}

/** The scan and the drops, on a session that already holds `TEMPLATE_LOCK`. */
async function sweep(
  session: pg.Client,
  currentTemplate: string,
  everyClone: boolean,
): Promise<string[]> {
  const dropped: string[] = [];
  const { rows } = await session.query<{ datname: string; description: string | null }>(
    "select d.datname, s.description from pg_database d left join pg_shdescription s" +
      " on s.objoid = d.oid and s.classoid = 'pg_database'::regclass" +
      ` where d.datname like 'cf\\_%'`,
  );
  const now = epochSeconds();
  for (const { datname, description } of rows) {
    if (datname === currentTemplate) continue;
    const clone = CLONE_NAME.exec(datname);
    if (clone) {
      if (!everyClone) {
        if (now - Number(clone[2]) <= ORPHAN_MAX_AGE_S) continue;
        if (processAlive(Number(clone[1]))) continue;
      }
    } else if (!TEMPLATE_NAME.test(datname)) {
      // Not a name this harness builds. Left alone rather than interpolated
      // into a DROP it has no business running.
      continue;
    } else {
      // A template this harness built always carries the epoch it was built at.
      // One with no comment is from something else, or from a build that was
      // killed before it could record itself — and a build cannot be in flight
      // here, because the lock is held across every build and every sweep.
      const built = description === null || description === "" ? 0 : Number(description);
      if (!Number.isFinite(built) || now - built <= STALE_TEMPLATE_MAX_AGE_S) continue;
      // Then the flag has to come off before the drop: `with (force)` overrides
      // the connected-sessions check and nothing else, and a template database
      // cannot be dropped at all (42809). Without this the cleanup below throws,
      // and since it runs on every template step it takes every later test in the
      // run with it — including `yarn test:pg-clean`, which is the way a person
      // gets out of exactly that state.
      await untemplate(session, datname);
    }
    await session.query(`drop database ${identifier(datname)} with (force)`);
    dropped.push(datname);
  }
  return dropped;
}

/**
 * Drop one name this harness built, whatever it is — the teardown a test that
 * planted a fixture of its own uses. The flag comes off first for the reason
 * `untemplate` gives, so a fixture that is a template (because a test built one,
 * or because a test marked one) is dropped like any other; the clone teardown
 * below knows its databases can only be clones and skips the extra statement.
 */
export async function dropHarnessDatabase(name: string): Promise<void> {
  const session = await maintenanceSession();
  try {
    await untemplate(session, name);
    await session.query(`drop database ${identifier(name)} with (force)`);
  } finally {
    await session.end();
  }
}

/**
 * The one migrated template every test copies, built once per migration set.
 *
 * Runs on a session that already holds the build lock, and holds it for the
 * WHOLE build, so N workers arriving together build it exactly once and the rest
 * find it finished. The lock is released only after the template is marked,
 * because a second worker arriving in the middle would otherwise see a plain
 * database and — correctly, for a killed build — drop the one being built.
 *
 * A database of the right name that is NOT a template is a build killed between
 * `CREATE` and `ALTER`: drop it and build again.
 */
async function buildTemplate(
  session: pg.Client,
  name: string,
  shipped: readonly Migration[],
): Promise<string> {
  await sweep(session, name, false);
  const existing = await session.query<{ datistemplate: boolean; description: string | null }>(
    "select d.datistemplate, s.description from pg_database d left join pg_shdescription s" +
      " on s.objoid = d.oid and s.classoid = 'pg_database'::regclass where d.datname = $1",
    [name],
  );
  if (existing.rows[0]?.datistemplate === true) {
    // A build killed between the `ALTER` below and its `COMMENT` leaves a
    // finished template that no cleanup can date: no comment reads as built at
    // zero, so it is stale to every other run the moment it is 24 h old, and
    // would be dropped out from under the tests copying it. It is the same
    // build, so it is stamped now.
    if (!existing.rows[0].description) {
      await session.query(`comment on database ${identifier(name)} is '${epochSeconds()}'`);
    }
    return name;
  }
  if (existing.rows.length > 0) {
    await session.query(`drop database ${identifier(name)} with (force)`);
  }
  await session.query(`create database ${identifier(name)}`);
  const build = pgClient(cloneConfig(name));
  try {
    await migrate(build, shipped);
  } finally {
    // A database cannot be marked a template while a session is connected to
    // it — and the next test's clone copies it.
    await build.end();
  }
  await session.query(`alter database ${identifier(name)} is_template true`);
  await session.query(`comment on database ${identifier(name)} is '${epochSeconds()}'`);
  return name;
}

/** `buildTemplate` with the lock and the session it needs, which is the whole of a build. */
async function build(name: string, shipped: readonly Migration[]): Promise<string> {
  const session = await maintenanceSession();
  try {
    await session.query("select pg_advisory_lock($1)", [TEMPLATE_LOCK]);
    return await buildTemplate(session, name, shipped);
  } finally {
    await session.query("select pg_advisory_unlock($1)", [TEMPLATE_LOCK]).catch(() => undefined);
    await session.end();
  }
}

/**
 * The templates this process has already built, by name.
 *
 * Every `migratedDatabase()` asks for one, and behind that ask sat the whole
 * build: a global advisory lock (so every worker on the host queues on it), a
 * `pg_database` scan and an orphan sweep, on a maintenance session apiece. The
 * row asks for the template to exist before the first clone, and the answer is
 * the same name every time after that — so the name is remembered, and only a
 * clone that finds the template gone (3D000, see `migratedServerDatabase`) takes
 * the memory back out and pays for the build again.
 *
 * Keyed by name, so a test asking for a synthetic migration set gets its own
 * entry and never inherits the shipped one. Per process, and a vitest file runs
 * in a process of its own, so this is per test file.
 */
const builtTemplates = new Map<string, Promise<string>>();

export async function ensureTemplate(migrations?: readonly Migration[]): Promise<string> {
  await requireServerReachable();
  const shipped = migrations ?? (await loadMigrations());
  const name = templateName(shipped);
  const remembered = builtTemplates.get(name);
  if (remembered) return remembered;
  const building = build(name, shipped);
  builtTemplates.set(name, building);
  // A build that failed is not an answer to hand the next test: the server was
  // down for a moment, it is not down forever.
  await building.catch(() => builtTemplates.delete(name));
  return building;
}

/** Stop believing this process built a template, so the next caller builds it again. */
function forgetTemplate(name: string): void {
  builtTemplates.delete(name);
}

/**
 * Run something in the window a build has, holding the lock every build and
 * every cleanup takes, with the build step itself handed in.
 *
 * This is how a test plants what a killed build leaves and then has the harness
 * adopt it: those two together are what a build does, and holding one lock
 * across both is what keeps another worker's sweep from taking the fixture in
 * between. It has to be that way in the product too — a template that is built
 * but not yet dated reads as built at zero, so it is stale to every other run
 * from the moment the build's lock is released, which is why a real build holds
 * that lock across its `ALTER` and its `COMMENT` together.
 *
 * The build step is handed in already bound to that session, because a build is
 * statements on the session holding the lock and `pg_advisory_lock` is
 * re-entrant per session and only there.
 */
export async function whileBuilding<T>(
  work: (build: (name: string, migrations: readonly Migration[]) => Promise<string>) => Promise<T>,
): Promise<T> {
  const session = await maintenanceSession();
  try {
    await session.query("select pg_advisory_lock($1)", [TEMPLATE_LOCK]);
    return await work((name, shipped) => buildTemplate(session, name, shipped));
  } finally {
    await session.query("select pg_advisory_unlock($1)", [TEMPLATE_LOCK]).catch(() => undefined);
    await session.end();
  }
}

/** True when a statement failed because the database it named does not exist. */
function isMissingDatabase(error: unknown): boolean {
  return (error as { code?: string }).code === "3D000";
}

/** Drop a database, from the maintenance connection: a database cannot drop itself. */
export async function drop(name: string): Promise<void> {
  await maintenanceStatement(`drop database ${identifier(name)} with (force)`);
}

/** A `SqlClient` whose `end()` also drops the database it was opened against. */
async function owning(config: DatabaseConfig): Promise<SqlClient> {
  const name = config.database;
  const client = pgClient(config);
  return {
    ...client,
    end: async () => {
      await client.end();
      await drop(name);
    },
  };
}

/**
 * A migrated database: a copy of the template, then the production client over
 * it. A copy rather than a migration run, because every test that wants a
 * migrated database wants the same one.
 */
export async function migratedServerDatabase(): Promise<SqlClient> {
  return migratedFromTemplate(await ensureTemplate());
}

/**
 * A copy of one named template, and what happens when that name is not there.
 *
 * Split out from the two lines above so the race can be tested without touching
 * the template the whole suite is cloning from: a template dropped out from
 * under a live suite is a fault in whoever dropped it, and this is a test.
 * `migrations` is the set that built that template, and it is what the retry
 * rebuilds — the shipped one for every database test there is.
 */
export async function migratedFromTemplate(
  template: string,
  migrations?: readonly Migration[],
): Promise<SqlClient> {
  const name = nextCloneName();
  try {
    await maintenanceStatement(
      `create database ${identifier(name)} template ${identifier(template)}`,
    );
  } catch (error) {
    if (!isMissingDatabase(error)) throw error;
    // Cleanup raced this clone and took the template between building and
    // copying. What this process remembered is now wrong, so it is forgotten
    // and rebuilt — once, because a template that keeps vanishing is a fault to
    // report, not to spin on.
    forgetTemplate(template);
    const rebuilt = await ensureTemplate(migrations);
    await maintenanceStatement(
      `create database ${identifier(name)} template ${identifier(rebuilt)}`,
    );
  }
  return owning(cloneConfig(name));
}

/** An empty database: a fresh `CREATE DATABASE`, with no template behind it. */
export async function emptyServerDatabase(): Promise<SqlClient> {
  await requireServerReachable();
  const name = nextCloneName();
  await maintenanceStatement(`create database ${identifier(name)}`);
  return owning(cloneConfig(name));
}

/**
 * Better Auth's pool, and the `SqlClient` over the SAME pool.
 *
 * The database is always empty: `schema-agreement.test.ts` needs an empty one to
 * run `migrate(sql, prior)` before `0008_auth`, and every other site migrates
 * what it finds, so a template behind this would be a template those migrations
 * could not be applied to.
 *
 * The idle-error handler is `instance.ts`'s, and it is on the pool rather than
 * inherited from `pgClient` because Better Auth holds this pool directly: an
 * unhandled `error` there would end the process.
 */
export async function authServerDatabase(): Promise<AuthDatabase> {
  await requireServerReachable();
  const name = nextCloneName();
  await maintenanceStatement(`create database ${identifier(name)}`);
  const config = cloneConfig(name);
  const pool = new pg.Pool(poolOptions(config));
  pool.on("error", (error) => {
    console.warn(`[auth] an idle connection failed: ${error.message}`);
  });
  return {
    pool,
    sql: pgClient(config, () => pool as unknown as PgPool),
    end: async () => {
      await pool.end();
      await drop(name);
    },
  };
}

/** What the four Better Auth sites swap in for their own `new PGlite()` dance. */
export interface AuthDatabase {
  readonly pool: PgPool;
  readonly sql: SqlClient;
  readonly end: () => Promise<void>;
}

/** The `cf_t_*` databases this process created and has not dropped. */
export async function leakedDatabases(): Promise<string[]> {
  await requireServerReachable();
  const session = await maintenanceSession();
  try {
    const { rows } = await session.query<{ datname: string }>(
      "select datname from pg_database where datname like $1",
      [`${CLONE_PREFIX}${process.pid}\\_%`],
    );
    return rows.map((r) => r.datname);
  } finally {
    await session.end();
  }
}
