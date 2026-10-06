import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "@campaignfoundry/shared";
import type { ObjectStorePort } from "@campaignfoundry/CampaignOrchestration";
import { databaseSettings, objectStore } from "../server/lib/config.js";
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
import { reconcileOrgs } from "../server/lib/deletion/reconcile.js";
import { describeCachePlan, expireCache } from "../server/lib/deletion/expire-cache.js";
import { purgeCampaign } from "../server/lib/deletion/purge-campaign.js";
import { objectStoreClient } from "../server/lib/object-store/index.js";
import { campaignPrefix, inputKey } from "../server/lib/object-store/object-keys.js";

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

export const USAGE_RECONCILE = "usage: yarn purge:reconcile [--org <id>] [--org <id> --apply]";
export const USAGE_CACHE = "usage: yarn purge:cache [--org <id>] [--org <id> --apply]";

/**
 * `--apply` deletes and REQUIRES `--org`: one org per operator run; the
 * all-orgs apply is the sweep's. Without `--apply` nothing is deleted (D239,
 * D242). `--dry-run` is the default spelled out.
 */
function parseOrgArgs(args: readonly string[], usage: string): { apply: boolean; org?: string } {
  let apply = false;
  let dryRun = false;
  let org: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--org" && args[i + 1] !== undefined) org = args[++i];
    else throw new Error(usage);
  }
  if (apply && dryRun) throw new Error(usage);
  if (apply && org === undefined) throw new Error(usage);
  return { apply, org };
}

export function parseReconcileArgs(args: readonly string[]): { apply: boolean; org?: string } {
  return parseOrgArgs(args, USAGE_RECONCILE);
}

export function parseCacheArgs(args: readonly string[]): { apply: boolean; org?: string } {
  return parseOrgArgs(args, USAGE_CACHE);
}

function s3Store(refusal: string): ObjectStorePort {
  if (objectStore() !== "s3") throw new Error(refusal);
  return objectStoreClient();
}

export function reconcileStore(): ObjectStorePort {
  return s3Store(
    "reconcile needs OBJECT_STORE=s3: the file store has no object store to reconcile.",
  );
}

export function cacheStore(): ObjectStorePort {
  return s3Store("cache needs OBJECT_STORE=s3: the file store has no object store to expire.");
}

export async function runReconcile(
  args: readonly string[],
  open: () => SqlClient = connect,
  log: (line: string) => void = console.log,
  store: () => ObjectStorePort = reconcileStore,
  now: () => number = Date.now,
): Promise<void> {
  const { apply, org } = parseReconcileArgs(args);
  const objects = store();
  const db = open();
  try {
    const { rows } = await db.query<{ id: string }>(`select id from org order by id`);
    const known = rows.map((row) => row.id);
    if (org !== undefined && !known.includes(org))
      throw new Error(`reconcile: unknown org "${org}"`);
    const { plans, applied } = await reconcileOrgs(db, objects, org === undefined ? known : [org], {
      apply,
      now,
    });
    for (const plan of plans) {
      log(
        `  org ${plan.orgId}: ${plan.prefixes.length} orphan prefix(es), ${plan.inputs.length} orphan input(s)`,
      );
      for (const prefix of plan.prefixes) {
        log(
          `    prefix ${campaignPrefix(plan.orgId, prefix.campaignId)} (${prefix.objects} object(s))`,
        );
      }
      for (const input of plan.inputs) {
        log(`    input ${inputKey(plan.orgId, input.campaignId, input.assetId)}`);
      }
    }
    log(
      apply
        ? `  Deleted ${applied.prefixes} prefix(es) and ${applied.inputs} input(s); skipped ${applied.skipped}.`
        : "  Dry run: nothing deleted. Re-run with --apply to delete.",
    );
  } finally {
    await db.end();
  }
}

/** The orgs of the `org` table, or exactly `org` when it is one of them (an unknown id is refused). */
async function orgsToVisit(
  db: SqlClient,
  org: string | undefined,
  command: string,
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(`select id from org order by id`);
  const known = rows.map((row) => row.id);
  if (org === undefined) return known;
  if (!known.includes(org)) throw new Error(`${command}: unknown org "${org}"`);
  return [org];
}

export async function runCache(
  args: readonly string[],
  open: () => SqlClient = connect,
  log: (line: string) => void = console.log,
  store: () => ObjectStorePort = cacheStore,
  now: () => number = Date.now,
): Promise<void> {
  const { apply, org } = parseCacheArgs(args);
  const objects = store();
  const db = open();
  try {
    const { deleted } = await expireCache(objects, await orgsToVisit(db, org, "cache"), {
      apply,
      now,
      onPlan: (plan) => {
        for (const line of describeCachePlan(plan)) log(line);
      },
    });
    log(
      apply
        ? `  Cache expiry: deleted ${deleted} object(s).`
        : "  Dry run: nothing deleted. Re-run with --org <id> --apply to delete.",
    );
  } finally {
    await db.end();
  }
}

/* istanbul ignore next -- CLI entry guard; main() is covered directly in tests */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  const rest = process.argv.slice(3);
  const run =
    command === "reconcile"
      ? runReconcile(rest)
      : command === "cache"
        ? runCache(rest)
        : main(command, process.argv.includes("--dry-run"));
  run.catch((error: unknown) => {
    console.error(`  x  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
