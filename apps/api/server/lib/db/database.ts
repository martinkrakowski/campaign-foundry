import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot } from "@campaignfoundry/shared";
import { databaseSettings } from "../config.js";
import { databaseConfig } from "./database-config.js";
import { pgClient } from "./pg-client.js";
import type { SqlClient } from "./sql-client.js";

let shared: SqlClient | undefined;

/**
 * The process's database (PT-3, D167: built at the composition root from the
 * environment). Built on first use, never at import, so a server on the file
 * stores opens nothing and needs no database settings.
 */
export function database(): SqlClient {
  shared ??= pgClient(
    databaseConfig(databaseSettings(), (path) =>
      readFileSync(resolve(projectRoot(), path), "utf8"),
    ),
  );
  return shared;
}

/** Install a database for every caller (a test's PGlite). */
export function setDatabase(client: SqlClient): void {
  shared = client;
}

/** Forget the database (the next `database()` builds one from the environment). */
export function resetDatabase(): void {
  shared = undefined;
}
