import { pathToFileURL } from "node:url";
import { dropEveryTestDatabase, testDatabaseBackend } from "./test-database.js";

/**
 * Drop every database the test harness left on the server `TEST_PG_URL` names.
 *
 *   yarn test:pg-clean
 *
 * The harness cleans up after itself in two places: a `cf_t_*` database an hour
 * old whose pid is gone, and a `cf_tpl_*` template a day old that no longer
 * matches the migration set. Those bounds are what make automatic cleanup safe
 * to run against a server two runs may be sharing — so a database younger than
 * that is still somebody's, and this script does not know it.
 *
 * This one is the manual, unbounded version, for when a run was killed hard
 * enough to leave a database an hour old, or when a server is being retired.
 * It waits for a build in flight rather than dropping the template that build is
 * half-way through writing — which is the one thing here that can lose a run.
 *
 * It is a script and not a test, so "it reads TEST_PG_URL" is true of it and of
 * nothing else in the harness; with the variable unset it says so and does
 * nothing, because there is no server and nothing to drop.
 */
export async function main(log: (line: string) => void = console.log): Promise<void> {
  if (testDatabaseBackend() !== "server") {
    log(
      "TEST_PG_URL is not set — nothing to clean. Set it to the test server to drop its databases.",
    );
    return;
  }
  const dropped = await dropEveryTestDatabase();
  log(
    dropped.length === 0
      ? "No test databases left on that server."
      : `Dropped ${dropped.length} database(s):\n${dropped.map((n) => `  ${n}`).join("\n")}`,
  );
}

/* istanbul ignore next -- script entry: the real main(), run by hand, not by a test. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`  x  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
