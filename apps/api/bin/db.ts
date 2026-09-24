import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "@campaignfoundry/shared";
import { databaseSettings } from "../server/lib/config.js";
import { databaseConfig, type DatabaseConfig } from "../server/lib/db/database-config.js";
import { loadMigrations, migrate } from "../server/lib/db/migrate.js";
import { pgClient } from "../server/lib/db/pg-client.js";
import type { SqlClient } from "../server/lib/db/sql-client.js";
import { loadEnv } from "../server/lib/env.js";

/**
 * The operator's database commands (PT-3). They run against whatever
 * `DATABASE_URL` names — the owner's Aiven service in practice — so they are the
 * operator's to run, never a test's.
 *
 *   yarn db:ping      one connection, `select version()`, closed
 *   yarn db:migrate   apply the migrations the database has not seen
 */
export const USAGE = "usage: yarn db:ping | yarn db:migrate";

/** The client the commands use: the environment's database, over a one-connection pool. */
export function connect(build: (config: DatabaseConfig) => SqlClient = pgClient): SqlClient {
  loadEnv();
  const config = databaseConfig(databaseSettings(), (path) =>
    readFileSync(resolve(projectRoot(), path), "utf8"),
  );
  return build({ ...config, max: 1 });
}

export async function main(
  command: string | undefined,
  open: () => SqlClient = connect,
  log: (line: string) => void = console.log,
): Promise<void> {
  if (command !== "ping" && command !== "migrate") throw new Error(USAGE);
  const db = open();
  try {
    if (command === "ping") {
      const { rows } = await db.query<{ version: string }>("select version() as version");
      log(`  Connected: ${rows[0]!.version}`);
      return;
    }
    const applied = await migrate(db, await loadMigrations());
    log(
      applied.length === 0
        ? "  The database is up to date."
        : `  Applied ${applied.length} migration(s): ${applied.join(", ")}`,
    );
  } finally {
    await db.end();
  }
}

/* istanbul ignore next -- CLI entry guard; main() is covered directly in tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch((error: unknown) => {
    console.error(`  x  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
