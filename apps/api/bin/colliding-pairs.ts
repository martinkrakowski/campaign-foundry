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

/**
 * A slug as printed: JSON's own quoting (which escapes the C0 controls, `"` and `\`),
 * then DEL (U+007F), the C1 controls (U+0080 to U+009F) and the bidirectional controls
 * (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069) as `\uXXXX`, so a stored
 * slug cannot move the cursor or reorder the line it is printed on.
 */
function printable(slug: string): string {
  return JSON.stringify(slug).replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

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
  let failed = false;
  try {
    const pairs = await findCollidingPairs(db);
    if (pairs.length === 0) {
      log("  No colliding campaign pairs found.");
      return 0;
    }
    for (const p of pairs) {
      log(
        `  org ${p.orgId}: campaign ${p.slugOwnerId} has slug ${printable(p.slugOwnerSlug)}, which is the uuid of campaign ${p.idOwnerId} (slug ${printable(p.idOwnerSlug)})`,
      );
    }
    log(`  ${pairs.length} colliding pair(s). Nothing was changed.`);
    return EXIT_FOUND;
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    // The first failure is the one reported: a close that fails too must not replace it.
    if (failed) await db.end().catch(() => undefined);
    else await db.end();
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
