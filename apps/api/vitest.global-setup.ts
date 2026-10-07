import type { TestProject } from "vitest/node";
import { loadMigrations } from "./server/lib/db/migrate.js";
import { buildSnapshots } from "./server/lib/db/__tests__/pglite-snapshot.js";

/** Build the empty + migrated PGlite data-dir snapshots once per run, before any worker. */
export default async function setup(project: TestProject): Promise<void> {
  if (process.env["TEST_PG_URL"]) return;
  project.provide("pgliteSnapshots", await buildSnapshots(await loadMigrations()));
}

declare module "vitest" {
  export interface ProvidedContext {
    pgliteSnapshots?: { empty: string; migrated: string };
  }
}
