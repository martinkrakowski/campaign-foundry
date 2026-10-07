import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { loadMigrations } from "./server/lib/db/migrate.js";
import { buildSnapshots } from "./server/lib/db/__tests__/pglite-snapshot.js";

/**
 * Build the empty + migrated PGlite data-dir snapshots once per run, in a
 * directory made for this run so no snapshot ever outlives the run that built it.
 * The teardown returned here removes that directory after the run.
 */
export default async function setup(project: TestProject): Promise<void | (() => void)> {
  if (process.env["TEST_PG_URL"]) return;
  const dir = mkdtempSync(join(tmpdir(), "cf-pglite-snap-"));
  project.provide("pgliteSnapshots", await buildSnapshots(await loadMigrations(), dir));
  return () => rmSync(dir, { recursive: true, force: true });
}

declare module "vitest" {
  export interface ProvidedContext {
    pgliteSnapshots?: { empty: string; migrated: string };
  }
}
