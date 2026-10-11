import { pathToFileURL } from "node:url";
import type { SqlClient } from "../server/lib/db/sql-client.js";
import { findCollidingPairs } from "../server/lib/deletion/colliding-pairs.js";
import { connect } from "./db.js";

export const USAGE_COLLIDING = "usage: yarn report:colliding-pairs [--help]";

/** `--help`: report only. */
export const HELP_COLLIDING = [
  USAGE_COLLIDING,
  "Report only: reads the campaigns and prints each pair whose slug is the uuid of another campaign of the same organisation. It renames nothing and writes nothing.",
  "exit codes:",
  "  0  no such pair was found",
  "  1  the command failed",
  "  2  at least one pair was found (nothing was changed)",
];

/** Exit code when at least one pair was found. */
export const EXIT_FOUND = 2;

export async function main(
  args: readonly string[],
  open: () => SqlClient = connect,
  log: (line: string) => void = console.log,
): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    for (const line of HELP_COLLIDING) log(line);
    return 0;
  }
  if (args.length > 0) throw new Error(USAGE_COLLIDING);
  const db = open();
  try {
    const pairs = await findCollidingPairs(db);
    if (pairs.length === 0) {
      log("  No colliding campaign pairs found.");
      return 0;
    }
    for (const p of pairs) {
      log(
        `  org ${p.orgId}: campaign ${p.slugOwnerId} has slug ${JSON.stringify(p.slugOwnerSlug)}, which is the uuid of campaign ${p.idOwnerId} (slug ${JSON.stringify(p.idOwnerSlug)})`,
      );
    }
    log(`  ${pairs.length} colliding pair(s). Nothing was changed.`);
    return EXIT_FOUND;
  } finally {
    await db.end();
  }
}

/* istanbul ignore next -- CLI entry guard; main() is covered directly in tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`  x  ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
