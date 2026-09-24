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
 * Connections one process holds by default. The Aiven service allows 15 in all,
 * and the API, the CLI and (PT-6) every worker share that budget.
 */
export const DEFAULT_POOL_MAX = 5;

/** The most one process may hold: the whole of the Aiven service's capacity. */
export const MAX_POOL = 15;

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

  let max = DEFAULT_POOL_MAX;
  if (settings.poolMax !== undefined && settings.poolMax !== "") {
    max = Number(settings.poolMax);
    if (!Number.isInteger(max) || max < 1 || max > MAX_POOL) {
      throw new Error(
        `DATABASE_POOL_MAX must be a whole number from 1 to ${MAX_POOL} (the service's capacity), not "${settings.poolMax}".`,
      );
    }
  }

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
