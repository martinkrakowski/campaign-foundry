import { pathToFileURL } from "node:url";
import type { SqlClient } from "../server/lib/db/sql-client.js";
import {
  eraseUser,
  finishErasure,
  ErasePassTwoError,
  type ActorCounts,
  type EraseUserCounts,
  type EraseUserRef,
} from "../server/lib/deletion/erase-user.js";
import { connect } from "./db.js";

export const USAGE_ERASE =
  "usage: yarn erase:user --email <email> [--apply] | yarn erase:user --user <id> [--apply] | yarn erase:user --finish <token> --user <id> --apply";

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

/** Parsed arguments: erase mode (email/user) or finish mode (--finish token + --user id). */
export type EraseArgs =
  | { readonly mode: "erase"; readonly ref: EraseUserRef; readonly apply: boolean }
  | {
      readonly mode: "finish";
      readonly token: string;
      readonly userId: string;
      readonly apply: boolean;
    };

/** Thrown when rows still name the erased user after pass two. */
export class EraseIncompleteError extends Error {
  constructor(token: string) {
    super(
      `erase incomplete: rows written while the erasure ran still name the user. Token ${token}. To finish, run: yarn erase:user --finish ${token} --user <the user's id> --apply`,
    );
    this.name = "EraseIncompleteError";
  }
}

/** Exit code: 3 for an incomplete erasure, 1 for all other errors. */
export function exitCodeFor(error: unknown): number {
  if (error instanceof EraseIncompleteError) return 3;
  if (error instanceof ErasePassTwoError) return 3;
  return 1;
}

/** Print one line per non-zero `ActorCounts` field, using COUNT_LINES labels. */
function logActorCounts(log: (line: string) => void, prefix: string, counts: ActorCounts): void {
  for (const [key, label] of COUNT_LINES) {
    const n = (counts as unknown as Record<string, number | undefined>)[key];
    if (n !== undefined && n > 0) log(`  ${prefix}: ${n} ${label}`);
  }
}

/**
 * `--apply` acts; the default is a dry run that prints counts. `--finish <token>`
 * with `--user <id> --apply` finishes an incomplete erasure. Exactly one mode,
 * each flag once. A refusal never echoes an argument.
 */
export function parseEraseArgs(args: readonly string[]): EraseArgs {
  let apply = false;
  let dryRun = false;
  let email: string | undefined;
  let user: string | undefined;
  let finish: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--finish" && finish === undefined) {
      const val = args[++i];
      if (val === undefined || val === "" || val.startsWith("-")) throw new Error(USAGE_ERASE);
      finish = val;
    } else if (arg === "--email" && email === undefined) {
      const val = args[++i];
      if (val === undefined || val === "" || val.startsWith("-")) throw new Error(USAGE_ERASE);
      email = val;
    } else if (arg === "--user" && user === undefined) {
      const val = args[++i];
      if (val === undefined || val === "" || val.startsWith("-")) throw new Error(USAGE_ERASE);
      user = val;
    } else throw new Error(USAGE_ERASE);
  }
  if (apply && dryRun) throw new Error(USAGE_ERASE);
  if (finish !== undefined) {
    if (user === undefined || email !== undefined) throw new Error(USAGE_ERASE);
    if (!apply) throw new Error(USAGE_ERASE);
    return { mode: "finish", token: finish, userId: user, apply };
  }
  if ((email === undefined) === (user === undefined)) throw new Error(USAGE_ERASE);
  return { mode: "erase", ref: email !== undefined ? { email } : { userId: user! }, apply };
}

export async function runErase(
  args: readonly string[],
  open: () => SqlClient,
  log: (line: string) => void,
): Promise<void> {
  const parsed = parseEraseArgs(args);
  const db = open();
  try {
    if (parsed.mode === "finish") {
      const { token, userId } = parsed;
      const { repaired, remaining } = await finishErasure(db, userId, token);
      logActorCounts(log, "repaired after commit", repaired);
      if (Object.values(remaining).some((n) => n > 0)) {
        logActorCounts(log, "STILL NAMING THE USER", remaining);
        throw new EraseIncompleteError(token);
      }
      log(`  Finished. Token ${token}.`);
      return;
    }

    const { ref, apply } = parsed;
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
      if (outcome.outcome === "erased") {
        logActorCounts(log, "repaired after commit", outcome.repaired);
        if (Object.values(outcome.remaining).some((n) => n > 0)) {
          logActorCounts(log, "STILL NAMING THE USER", outcome.remaining);
          throw new EraseIncompleteError(outcome.token);
        }
      }
    } catch (e) {
      if (e instanceof ErasePassTwoError) {
        for (const [key, label] of COUNT_LINES) log(`  ${label}: ${e.counts[key]}`);
      }
      throw e;
    }
  } finally {
    await db.end();
  }
}

/* istanbul ignore next -- CLI entry guard; runErase() is covered directly in tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runErase(process.argv.slice(2), connect, console.log).catch((error: unknown) => {
    console.error(`  x  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = exitCodeFor(error);
  });
}
