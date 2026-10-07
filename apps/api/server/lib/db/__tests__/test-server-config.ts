/**
 * Test-only: lets the API test harness reach a private host that `TEST_PG_URL`
 * or `TEST_DATABASE_URL` names, WITHOUT changing production `databaseConfig`.
 *
 * Never imported by `src/` or `server/` non-test code. `vitest.config.ts`
 * excludes the `__tests__` glob from coverage, so this file is outside the 100%
 * gate — but `test-server-config.test.ts` covers every branch anyway.
 *
 * The allow-list is opt-in and exact: `TEST_PG_ALLOW_HOSTS` holds
 * comma-separated IPv4 literals. An entry is accepted only if it is a
 * dotted-decimal address inside 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16;
 * anything else (a name, `*`, a CIDR, a public address, an empty entry,
 * 0.0.0.0, 127.x) makes reading the list THROW. There is no default value
 * anywhere in code or in a test fixture: unset or empty means "no entries",
 * which is today's byte-for-byte behaviour (every non-loopback host refused).
 *
 * A listed host is still a REMOTE host to `databaseConfig`, and
 * `databaseConfig` has one rule for a remote host: it needs a CA. So the
 * helper calls `databaseConfig` with the listed host's URL as-is first; when
 * it refuses with the CA message the helper re-runs the SAME validator with the
 * host swapped to `127.0.0.1` (a local host, so `ssl: false` and no CA), then
 * restores the real host on the result. The shared test server has no TLS, so an
 * admitted host connects with `ssl: false`. A listed host with a
 * `DATABASE_CA_PATH`-style CA is not supported: the callback still throws
 * ("a local X needs no CA"), and production `databaseConfig` is never reached
 * for a listed host with a CA path.
 */
import { databaseConfig, type DatabaseConfig } from "../database-config.js";

/**
 * Matches `databaseConfig`'s remote-host refusal, copied from the wording the
 * server test pins (`test-database.server.test.ts:454`).
 */
const REMOTE_HOST = /^DATABASE_CA_PATH is not set/;

/** Four dotted decimal octets, each 0–255 with no leading zeros. */
function isDottedQuad(candidate: string): boolean {
  const octets = candidate.split(".");
  if (octets.length !== 4) return false;
  for (const octet of octets) {
    if (!/^\d+$/.test(octet)) return false;
    if (octet.length > 1 && octet.startsWith("0")) return false;
    const value = Number(octet);
    if (value < 0 || value > 255) return false;
  }
  return true;
}

/** True only for an IPv4 literal in 10/8, 172.16/12 or 192.168/16. */
function isPrivateIPv4(candidate: string): boolean {
  if (!isDottedQuad(candidate)) return false;
  const [a, b] = candidate.split(".").map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/**
 * Read `TEST_PG_ALLOW_HOSTS` as a closed, exact set.
 *
 * A bad entry throws rather than being silently dropped, and the default (unset
 * or empty) is no entries — today's behaviour byte for byte. Parse happens here,
 * at read time, so a malformed list fails even when the URL it guards would
 * otherwise be localhost.
 */
export function parseAllowHosts(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set<string>();
  const result = new Set<string>();
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!isPrivateIPv4(trimmed)) {
      throw new Error(`TEST_PG_ALLOW_HOSTS entry "${trimmed}" is not a private IPv4 address`);
    }
    result.add(trimmed);
  }
  return result;
}

/**
 * Build the driver config for a test database URL the harness may reach.
 *
 * `name` is the env variable the caller read the URL from — `TEST_PG_URL` for
 * the template/migration server path, `TEST_DATABASE_URL` for the CI
 * concurrency proofs — and is what a refusal names so a reader is not sent to
 * change the application's `DATABASE_URL`. A host not on `allowHosts` is
 * refused with the same message `databaseConfig` would have made, retold
 * against `name`.
 */
export function testServerConfig(
  raw: { url: string | undefined; poolMax?: string },
  name: "TEST_PG_URL" | "TEST_DATABASE_URL",
  allowHosts: string | undefined = process.env["TEST_PG_ALLOW_HOSTS"],
): DatabaseConfig {
  // Parse the list first, so a malformed entry fails even for a loopback URL.
  const allowed = parseAllowHosts(allowHosts);
  const noCa = () => {
    throw new Error(`a local ${name} needs no CA`);
  };
  try {
    return databaseConfig({ url: raw.url, poolMax: raw.poolMax }, noCa);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Not the remote-host case: re-point `DATABASE_URL` at the test variable and
    // pass the error on unchanged in substance.
    if (!REMOTE_HOST.test(message)) {
      throw new Error(message.replaceAll("DATABASE_URL", name), { cause: error });
    }
    // `databaseConfig` already proved `raw.url` parses as a postgres URL, so
    // reading the host it named is safe here and never throws on its own.
    const url = new URL(raw.url!);
    const listed = allowed.has(url.hostname);
    if (listed) {
      const originalHost = url.hostname;
      url.hostname = "127.0.0.1";
      const config = databaseConfig({ url: url.toString(), poolMax: raw.poolMax }, noCa);
      return { ...config, host: originalHost };
    }
    throw new Error(
      `${name} names a remote database, and the test harness only reaches a local test server.`,
      { cause: error },
    );
  }
}
