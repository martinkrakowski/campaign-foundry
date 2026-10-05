import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "@campaignfoundry/shared";
import { databaseSettings } from "../server/lib/config.js";
import { databaseConfig, type DatabaseConfig } from "../server/lib/db/database-config.js";
import { pgClient } from "../server/lib/db/pg-client.js";
import type { SqlClient } from "../server/lib/db/sql-client.js";
import { loadEnv } from "../server/lib/env.js";
import {
  claimDue,
  listDue,
  recordFailure,
  type DeletionRow,
} from "../server/lib/deletion/deletion-store.js";
import { purgeCampaign } from "../server/lib/deletion/purge-campaign.js";

export const USAGE = "usage: yarn purge:sweep [-- --dry-run]";

/**
 * A hard per-invocation cap, proposed here — the plan sets no number
 * (`docs/planning/2026-10-04_pt-9-deletion-and-erasure.md:118` names no
 * bound; cite and replace this if a later revision adds one). `claimDue`
 * cannot hand the same row back inside one run (see `sweep`'s own doc
 * comment), so the loop is already bounded by however many rows are due AT
 * THE MOMENT it starts — but new `deletion` rows can be inserted while a
 * sweep is running (a live `DELETE` route, once PT-9f ships), so an
 * unbounded loop under sustained delete traffic could run past the next
 * `purge-cronjob.yaml` tick (`:128`, every 10 min, `concurrencyPolicy:
 * Forbid` — the next tick is simply skipped, not queued). Capping one
 * invocation's batch keeps each run's worst case bounded and lets a large
 * backlog drain over several ticks instead of one unbounded run. The number
 * itself is arbitrary (well above any realistic staging backlog); the
 * orchestrator may raise or drop it.
 */
export const MAX_CLAIMS_PER_SWEEP = 500;

export function connect(build: (config: DatabaseConfig) => SqlClient = pgClient): SqlClient {
  loadEnv();
  const config = databaseConfig(databaseSettings(), (path) =>
    readFileSync(resolve(projectRoot(), path), "utf8"),
  );
  return build({ ...config, max: 1 });
}

/**
 * Claim and purge due rows, one `log` line per row (id, kind, outcome — the
 * project convention for a `bin/` script, `AGENTS.md`'s own Conventions
 * section: "the only exempt sites are the logger transport, server startup,
 * scripts, and config files" — confirmed no `logger.ts`/structured logger
 * exists anywhere in this repo, `find . -iname logger.ts` is empty, so this
 * mirrors `db.ts`'s and `worker.ts`'s own injected `log` callback, not a new
 * convention), until none remain or `MAX_CLAIMS_PER_SWEEP` claims have been
 * made in this run, whichever comes first. No "seen this id before" guard is
 * needed beyond that cap: `recordFailure` (PT-9g1, shipped) leaves a failed
 * row's `claimed_until` standing rather than clearing it, so `claimDue`
 * cannot hand the SAME row back within `PURGE_LEASE_MS` of its claim — a long
 * sweep CAN outlast the 5-minute lease and reclaim a row it already failed
 * earlier in this same run; harmless, since `MAX_CLAIMS_PER_SWEEP` bounds the
 * retry count and every step it re-attempts is idempotent (D232).
 */
export async function sweep(
  db: SqlClient,
  log: (line: string) => void,
  claim: (db: SqlClient) => Promise<DeletionRow | undefined> = claimDue,
  purge: (
    db: SqlClient,
    orgId: string,
    row: Pick<DeletionRow, "id" | "subject">,
  ) => Promise<"purged" | "retry"> = purgeCampaign,
): Promise<{ purged: number; failed: number }> {
  let purged = 0;
  let failed = 0;
  for (let claims = 0; claims < MAX_CLAIMS_PER_SWEEP; claims++) {
    const row = await claim(db);
    if (!row) break;
    if (row.kind !== "campaign") {
      // PT-9l/9m (unshipped) own 'user' and 'org'. The CHECK constraint
      // already allows them; this sweep must not crash on one, and must not
      // claim it as done either.
      const message = `${row.kind} purge is not implemented yet (PT-9l/9m).`;
      await recordFailure(db, row.id, message);
      failed++;
      log(`  ${row.kind} ${row.id}: failed (${message})`);
      continue;
    }
    if (row.orgId === null) {
      // 0017_deletion.sql's own CHECK ties this: `(kind = 'user') = (org_id
      // is null)`, so a 'campaign' row can never actually reach this branch
      // today. Defensive, not reachable — a constraint a later migration
      // could in principle relax, and `purgeCampaign` requires a non-null
      // `orgId: string`, so this guards the type as much as the data.
      const message = `campaign deletion row ${row.id} has a null org_id`;
      await recordFailure(db, row.id, message);
      failed++;
      log(`  campaign ${row.id}: failed (${message})`);
      continue;
    }
    try {
      const outcome = await purge(db, row.orgId, row);
      if (outcome === "purged") purged++;
      // "retry" already recorded its own last_error inside purgeCampaign
      // (PT-9g2, shipped) — nothing more to do here; it is neither purged
      // nor failed, and `recordFailure` must NOT be called again for it.
      log(`  campaign ${row.id}: ${outcome}`);
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      await recordFailure(db, row.id, message);
      log(`  campaign ${row.id}: failed (${message})`);
    }
  }
  return { purged, failed };
}

export async function main(
  command: string | undefined,
  dryRun: boolean,
  open: () => SqlClient = connect,
  log: (line: string) => void = console.log,
): Promise<void> {
  if (command !== "sweep") throw new Error(USAGE);
  const db = open();
  try {
    if (dryRun) {
      const due = await listDue(db);
      if (due.length === 0) {
        log("  Nothing due.");
        return;
      }
      for (const row of due) {
        log(`  ${row.kind} "${row.subject}" (org ${row.orgId ?? "—"})`);
      }
      return;
    }
    const { purged, failed } = await sweep(db, log);
    log(`  Purged ${purged} deletion row(s), ${failed} failed.`);
  } finally {
    await db.end();
  }
}

/* istanbul ignore next -- CLI entry guard; main() is covered directly in tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2], process.argv.includes("--dry-run")).catch((error: unknown) => {
    console.error(`  x  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
