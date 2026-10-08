import { pathToFileURL } from "node:url";
import type { SqlClient } from "../server/lib/db/sql-client.js";
import {
  eraseUser,
  type EraseUserCounts,
  type EraseUserRef,
} from "../server/lib/deletion/erase-user.js";
import { connect } from "./db.js";

export const USAGE_ERASE =
  "usage: yarn erase:user --email <email> [--apply] | yarn erase:user --user <id> [--apply]";

/** The count lines, in the order they print. */
const COUNT_LINES: readonly (readonly [keyof EraseUserCounts, string])[] = [
  ["briefVersions", "brief versions re-attributed"],
  ["decisions", "decisions re-attributed"],
  ["providerKeys", "provider keys re-attributed"],
  ["campaignsDeletedBy", "campaigns re-attributed"],
  ["deletionsRequestedBy", "deletion requests re-attributed"],
  ["drafts", "drafts deleted"],
  ["lastOpened", "last-opened pointers deleted"],
  ["verifications", "verification rows deleted"],
  ["invitationsAsInvitee", "invitations to the user deleted"],
  ["invitationsAsInviter", "invitations from the user deleted"],
  ["sessions", "sessions deleted"],
  ["accounts", "accounts deleted"],
  ["members", "memberships deleted"],
  ["teamMembers", "team memberships deleted"],
  ["teams", "teams recounted"],
];

/**
 * `--apply` acts; the default is a dry run that prints counts. Exactly one of
 * `--email` / `--user`, each once. A refusal never echoes an argument.
 */
export function parseEraseArgs(args: readonly string[]): { ref: EraseUserRef; apply: boolean } {
  let apply = false;
  let dryRun = false;
  let email: string | undefined;
  let user: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--email" && email === undefined && args[i + 1] !== undefined)
      email = args[++i];
    else if (arg === "--user" && user === undefined && args[i + 1] !== undefined) user = args[++i];
    else throw new Error(USAGE_ERASE);
  }
  if (apply && dryRun) throw new Error(USAGE_ERASE);
  if ((email === undefined) === (user === undefined)) throw new Error(USAGE_ERASE);
  return { ref: email !== undefined ? { email } : { userId: user! }, apply };
}

export async function runErase(
  args: readonly string[],
  open: () => SqlClient,
  log: (line: string) => void,
): Promise<void> {
  const { ref, apply } = parseEraseArgs(args);
  const db = open();
  try {
    const outcome = await eraseUser(db, ref, { apply });
    if (outcome.outcome === "not-found") throw new Error("erase: no such user.");
    if (outcome.outcome === "sole-owner") {
      throw new Error(
        `erase refused: the user is the only owner of org ${outcome.orgIds.join(", ")}; move ownership or delete the org first.`,
      );
    }
    for (const [key, label] of COUNT_LINES) log(`  ${label}: ${outcome.counts[key]}`);
    log(
      outcome.outcome === "erased"
        ? `  Erased. Token ${outcome.token}.`
        : "  Dry run: nothing changed. Re-run with --apply to erase.",
    );
  } finally {
    await db.end();
  }
}

/* istanbul ignore next -- CLI entry guard; runErase() is covered directly in tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runErase(process.argv.slice(2), connect, console.log).catch((error: unknown) => {
    console.error(`  x  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
