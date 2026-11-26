/**
 * How the API reaches its database (D174a: PostgreSQL, hosted on Aiven).
 *
 * Pure: the composition root reads the raw settings (`config.ts`) and the CA file,
 * and this turns them into a driver config or refuses. Nothing here is taken from
 * the URL's own `sslmode`, whose meaning has changed across `pg` releases: a remote
 * database is always reached over TLS that verifies the server certificate against
 * the CA the operator provides, and a local one (a developer's own Postgres) over
 * plain TCP unless a CA is given.
 */

/** The raw settings, as `config.ts` reads them from the environment. */
export interface DatabaseSettings {
  /** `DATABASE_URL`: `postgres://user:password@host:port/database`. */
  readonly url?: string;
  /** `DATABASE_CA_PATH`: the server's CA certificate (PEM), e.g. Aiven's `ca.pem`. */
  readonly caPath?: string;
  /** `DATABASE_POOL_MAX`: connections this process may hold. */
  readonly poolMax?: string;
  /** `AUTH_POOL_MAX`: connections Better Auth's own pool may hold. */
  readonly authPoolMax?: string;
  /** `DATABASE_POOL_CEILING`: the per-process ceiling on all connection pools. */
  readonly poolCeiling?: string;
}

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly ssl: false | { readonly ca: string; readonly rejectUnauthorized: true };
  readonly max: number;
}

/**
 * Connections one process's store pool holds by default. The API, the CLI and
 * (PT-6) every worker share the process's connection budget.
 */
export const DEFAULT_POOL_MAX = 5;

/** The default per-process connection ceiling: every pool must fit within it. */
export const MAX_POOL = 15;

/**
 * Better Auth's dedicated connection pool budget by default (PT-1a, Finding 3).
 * Kept small (2) so the store pool and auth pool together stay within the
 * ceiling. Total per process: DATABASE_POOL_MAX + AUTH_POOL_MAX <= DATABASE_POOL_CEILING.
 */
export const AUTH_POOL_MAX = 2;
export const BETTER_AUTH_POOL_MAX = AUTH_POOL_MAX;

/** Parse one raw connection count, falling back to the default when unset. */
function parseCount(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} must be a whole number of at least 1, not "${raw}".`);
  }
  return n;
}

/** The per-process connection budget: each pool's size and the ceiling that binds them. */
export interface PoolBudget {
  readonly poolMax: number;
  readonly authPoolMax: number;
  readonly ceiling: number;
}

/**
 * Turn the raw settings into the process's connection budget, or throw naming
 * the offending setting: `poolMax + authPoolMax` must never exceed the ceiling.
 */
export function poolBudget(settings: DatabaseSettings): PoolBudget {
  const ceiling = parseCount("DATABASE_POOL_CEILING", settings.poolCeiling, MAX_POOL);
  const authPoolMax = parseCount("AUTH_POOL_MAX", settings.authPoolMax, AUTH_POOL_MAX);
  const poolMax = parseCount("DATABASE_POOL_MAX", settings.poolMax, DEFAULT_POOL_MAX);
  if (poolMax + authPoolMax > ceiling) {
    throw new Error(
      `DATABASE_POOL_MAX (${poolMax}) + AUTH_POOL_MAX (${authPoolMax}) exceeds DATABASE_POOL_CEILING (${ceiling}).`,
    );
  }
  return { poolMax, authPoolMax, ceiling };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Turn the raw settings into a driver config, or throw naming what is wrong (never the password). */
export function databaseConfig(
  settings: DatabaseSettings,
  readCa: (path: string) => string,
): DatabaseConfig {
  if (!settings.url) throw new Error("DATABASE_URL is not set.");
  let url: URL;
  try {
    url = new URL(settings.url);
  } catch {
    throw new Error("DATABASE_URL is not a URL.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`DATABASE_URL must be a postgres:// URL, not ${url.protocol}//.`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !url.username || !database) {
    throw new Error("DATABASE_URL must name a host, a user and a database.");
  }

  let ssl: DatabaseConfig["ssl"] = false;
  if (settings.caPath) {
    ssl = { ca: readCa(settings.caPath), rejectUnauthorized: true };
  } else if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(
      `DATABASE_CA_PATH is not set: a remote database (${url.hostname}) is reached only over TLS ` +
        "that verifies its certificate. Download the service's CA certificate (Aiven: the service " +
        "page, CA certificate) to a gitignored path and point DATABASE_CA_PATH at it.",
    );
  }

  const { poolMax: max } = poolBudget(settings);

  return {
    // An IPv6 literal is bracketed in a URL and bare to the driver.
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port: url.port === "" ? 5432 : Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl,
    max,
  };
}
