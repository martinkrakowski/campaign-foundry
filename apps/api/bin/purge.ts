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
import {
  describePlan,
  describeStep,
  reconcileOrgs,
  type ReconcilePlan,
  type ReconcileStep,
} from "../server/lib/deletion/reconcile.js";
import { describeCachePlan, expireCache } from "../server/lib/deletion/expire-cache.js";
import { purgeCampaign } from "../server/lib/deletion/purge-campaign.js";
import { purgeOrg, requestOrgDeletion } from "../server/lib/deletion/purge-org.js";
import { expireOrgTombstones, ORG_RETENTION } from "../server/lib/deletion/expire-org.js";
import { LOCAL_TENANT } from "../server/lib/tenant.js";
import { objectStoreClient } from "../server/lib/object-store/index.js";

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
 * Dispatch by kind (D241): the default `purge` of `sweep`. An org row is purged
 * by `purgeOrg` (which queues the org's campaign purges and answers "retry"
 * until none remain), a campaign row by `purgeCampaign`. `user` rows never
 * reach it: `sweep` releases them as not implemented until PT-9l.
 */
export async function purgeRow(
  db: SqlClient,
  orgId: string,
  row: Pick<DeletionRow, "id" | "subject" | "kind" | "requestedBy">,
): Promise<"purged" | "retry"> {
  return row.kind === "org" ? purgeOrg(db, orgId, row) : purgeCampaign(db, orgId, row);
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
 *
 * Org rows are purged through `purgeOrg` (which queues the org's campaign
 * purges and answers "retry" while any campaign deletion row remains due);
 * a "retry" row waits out its lease (5 minutes, `PURGE_LEASE_MS`), so an
 * org purge needs at least two sweeps. `user` rows are released as not
 * implemented until PT-9l ships.
 */
export async function sweep(
  db: SqlClient,
  log: (line: string) => void,
  claim: (db: SqlClient) => Promise<DeletionRow | undefined> = claimDue,
  purge: (
    db: SqlClient,
    orgId: string,
    row: Pick<DeletionRow, "id" | "subject" | "kind" | "requestedBy">,
  ) => Promise<"purged" | "retry"> = purgeRow,
): Promise<{ purged: number; failed: number }> {
  let purged = 0;
  let failed = 0;
  for (let claims = 0; claims < MAX_CLAIMS_PER_SWEEP; claims++) {
    const row = await claim(db);
    if (!row) break;
    if (row.kind === "user") {
      // PT-9l/9m (unshipped) own 'user'. The CHECK constraint already allows
      // it; this sweep must not crash on one, and must not claim it as done.
      // An 'org' row is purged by the `purge` callback (`purgeRow`).
      const message = `${row.kind} purge is not implemented yet (PT-9l/9m).`;
      await recordFailure(db, row.id, message);
      failed++;
      log(`  ${row.kind} ${row.id}: failed (${message})`);
      continue;
    }
    if (row.orgId === null) {
      // 0017_deletion.sql's own CHECK ties this: `(kind = 'user') = (org_id
      // is null)`, so a 'campaign' or 'org' row can never actually reach this
      // branch today. Defensive, not reachable — a constraint a later migration
      // could in principle relax, and `purgeCampaign` requires a non-null
      // `orgId: string`, so this guards the type as much as the data.
      const message = `${row.kind} deletion row ${row.id} has a null org_id`;
      await recordFailure(db, row.id, message);
      failed++;
      log(`  ${row.kind} ${row.id}: failed (${message})`);
      continue;
    }
    try {
      const outcome = await purge(db, row.orgId, row);
      if (outcome === "purged") purged++;
      // "retry" is recorded by purgeCampaign (PT-9g2, via recordFailure for
      // an active job) or by purgeOrg (PT-9m2, via recordFailure for ORG_BLOCKED_MESSAGE);
      // a campaign retry leaves its own last_error. purgeOrg's "campaigns remain"
      // retry answers "retry" without setting last_error here — nothing more to do.
      log(`  ${row.kind} ${row.id}: ${outcome}`);
    } catch (error) {
      failed++;
      const message = error instanceof Error ? error.message : String(error);
      await recordFailure(db, row.id, message);
      log(`  ${row.kind} ${row.id}: failed (${message})`);
    }
  }
  return { purged, failed };
}

export async function main(
  command: string | undefined,
  dryRun: boolean,
  open: () => SqlClient = connect,
  log: (line: string) => void = console.log,
  after: (db: SqlClient, log: (line: string) => void) => Promise<number> = housekeeping,
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
    const stepsFailed = await after(db, log);
    if (stepsFailed > 0) {
      throw new Error(`${stepsFailed} housekeeping step(s) failed; see the lines above.`);
    }
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
    // A second `--org` is refused, never "last one wins": with `--apply` that would delete
    // in an org the operator may not have meant.
    else if (arg === "--org" && org === undefined && args[i + 1] !== undefined) org = args[++i];
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

export const USAGE_ORG = "usage: yarn purge:org --org <id> [--apply]";

/**
 * `--org` is REQUIRED (an org deletion names its org) and `--apply` is the only
 * thing that changes anything; `--dry-run` is the default spelled out. A second
 * `--org` is refused, never "last one wins". `local` can never be deleted.
 */
export function parseOrgPurgeArgs(args: readonly string[]): { apply: boolean; org: string } {
  let apply = false;
  let dryRun = false;
  let org: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--org" && org === undefined && args[i + 1] !== undefined) {
      org = args[++i];
      if (org === "" || org.startsWith("-")) throw new Error(USAGE_ORG);
    } else throw new Error(USAGE_ORG);
  }
  if (apply && dryRun) throw new Error(USAGE_ORG);
  if (org === undefined) throw new Error(USAGE_ORG);
  if (org === LOCAL_TENANT.orgId) throw new Error('org "local" can never be deleted.');
  return { apply, org };
}

export const USAGE_ORG_EXPIRE = "usage: yarn purge:org-expire [--org <id>] [--org <id> --apply]";

export function parseOrgExpireArgs(args: readonly string[]): { apply: boolean; org?: string } {
  return parseOrgArgs(args, USAGE_ORG_EXPIRE);
}

export async function runOrgPurge(
  args: readonly string[],
  open: () => SqlClient = connect,
  log: (line: string) => void = console.log,
): Promise<void> {
  const { apply, org } = parseOrgPurgeArgs(args);
  const db = open();
  try {
    const { rows } = await db.query<{ deleted_at: Date | null }>(
      `select deleted_at from org where id = $1`,
      [org],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`org: unknown org "${org}"`);
    if (!apply) {
      const live = (
        await db.query<{ n: number }>(
          `select count(*)::int as n from campaign where org_id = $1 and deleted_at is null`,
          [org],
        )
      ).rows[0]!.n;
      const tombstoned = (
        await db.query<{ n: number }>(
          `select count(*)::int as n from campaign where org_id = $1 and deleted_at is not null`,
          [org],
        )
      ).rows[0]!.n;
      const members = (
        await db.query<{ n: number }>(`select count(*)::int as n from member where org_id = $1`, [
          org,
        ])
      ).rows[0]!.n;
      const teams = (
        await db.query<{ n: number }>(`select count(*)::int as n from team where org_id = $1`, [
          org,
        ])
      ).rows[0]!.n;
      const invitations = (
        await db.query<{ n: number }>(
          `select count(*)::int as n from invitation where org_id = $1`,
          [org],
        )
      ).rows[0]!.n;
      const keys = (
        await db.query<{ n: number }>(
          `select count(*)::int as n from provider_key where org_id = $1`,
          [org],
        )
      ).rows[0]!.n;
      const orgTombstoned = row.deleted_at !== null;
      log(
        `  org ${org}: ${live} live campaign(s), ${tombstoned} tombstoned, ${members} member(s), ${teams} team(s), ${invitations} invitation(s), ${keys} provider key(s)`,
      );
      log(`  state: ${orgTombstoned ? "tombstoned" : "live"}`);
      log(
        "  Dry run: nothing changed. Re-run with --apply to tombstone the org and queue its purge, then run yarn purge:sweep.",
      );
      return;
    }
    const outcome = await requestOrgDeletion(db, { orgId: org, requestedBy: "operator" });
    if (outcome === "requested") {
      log(`  Org ${org}: deletion requested; run yarn purge:sweep to purge it.`);
    } else {
      log(`  Org ${org}: deletion was already requested.`);
    }
  } finally {
    await db.end();
  }
}

export async function runOrgExpire(
  args: readonly string[],
  open: () => SqlClient = connect,
  log: (line: string) => void = console.log,
): Promise<void> {
  const { apply, org } = parseOrgExpireArgs(args);
  const db = open();
  try {
    const { eligible, expired, failed } = await expireOrgTombstones(db, { apply, org });
    if (org !== undefined && eligible.length === 0) {
      throw new Error(
        `org-expire: org "${org}" is not eligible: it must be tombstoned, fully purged and older than ${ORG_RETENTION}.`,
      );
    }
    if (apply) {
      log(`  Expired ${expired.length} org tombstone(s).`);
      for (const id of failed) {
        log(
          `  org ${id}: failed (could not be expired; a row may still reference it); it is left in place`,
        );
      }
      if (failed.length > 0) {
        throw new Error(
          `org-expire: ${failed.length} org(s) could not be expired; see the lines above.`,
        );
      }
      return;
    }
    // Dry run
    if (eligible.length > 0) {
      for (const id of eligible) {
        log(`  org ${id}: eligible (tombstoned over ${ORG_RETENTION} ago, purge complete)`);
      }
    } else {
      log("  Nothing to expire.");
    }
    log("  Dry run: nothing deleted. Re-run with --org <id> --apply to delete.");
  } finally {
    await db.end();
  }
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

/** The two hooks that give `reconcileOrgs` its record: each plan before the first delete, each step as it completes. */
function reconcileLogging(log: (line: string) => void): {
  onPlan: (plan: ReconcilePlan) => void;
  onStep: (step: ReconcileStep) => void;
} {
  return {
    onPlan: (plan) => {
      for (const line of describePlan(plan)) log(line);
    },
    onStep: (step) => log(describeStep(step)),
  };
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
    const { applied } = await reconcileOrgs(db, objects, await orgsToVisit(db, org, "reconcile"), {
      apply,
      now,
      ...reconcileLogging(log),
    });
    log(
      apply
        ? `  Deleted ${applied.prefixes} prefix(es) and ${applied.inputs} input(s); skipped ${applied.skipped}.`
        : "  Dry run: nothing deleted. Re-run with --apply to delete.",
    );
  } finally {
    await db.end();
  }
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

/**
 * Per sweep, more reconcile candidates than this and the UNATTENDED apply
 * refuses to delete any of them: a database that looks empty or wrong makes
 * every prefix older than an hour an "orphan". An operator reviews with
 * `yarn purge:reconcile --org <id>` and applies per org (no cap there). The
 * number is arbitrary and the orchestrator's to change.
 */
export const SWEEP_RECONCILE_MAX_CANDIDATES = 100;

/**
 * `PURGE_RECONCILE`: `off` turns the sweep's reconcile off; unset, empty or `on`
 * leaves it on (the plan says the sweep runs it). Anything else is refused. The
 * cache expiry has no switch.
 */
export function reconcileSwitch(): boolean {
  loadEnv();
  const value = process.env.PURGE_RECONCILE;
  if (value === undefined || value === "" || value === "on") return true;
  if (value === "off") return false;
  throw new Error(`PURGE_RECONCILE must be "on" or "off".`);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What the sweep does after its claim loop: reconcile every org, then expire
 * the old cache objects of every org. The two steps are independent: each is
 * wrapped, a failure is logged and counted, and the other still runs. Returns
 * the number of failed steps (`main` turns it into the exit code). The purges
 * that already ran are committed and unaffected.
 */
export async function housekeeping(
  db: SqlClient,
  log: (line: string) => void,
  now: () => number = Date.now,
): Promise<number> {
  if (objectStore() !== "s3") {
    log("  Reconcile and cache expiry skipped: OBJECT_STORE is not s3.");
    return 0;
  }
  let objects: ObjectStorePort | undefined;
  let orgIds: readonly string[] | undefined;
  let failed = 0;
  try {
    objects = objectStoreClient();
    orgIds = await orgsToVisit(db, undefined, "sweep");
  } catch (error) {
    // `expireCache` needs both the store client and the org list, so a failure
    // of either setup step means the cache step cannot run either; both are
    // counted as failed (A1). When PURGE_RECONCILE=off the reconcile step would
    // have been skipped, so it is not counted as a failure here — only the
    // cache step is.
    if (process.env.PURGE_RECONCILE !== "off") {
      log(`  reconcile failed (${reason(error)})`);
      failed++;
    } else {
      log("  Reconcile skipped: PURGE_RECONCILE=off.");
    }
    log("  cache expiry failed (setup failed: store client or org list unavailable)");
    failed++;
    return failed;
  }
  try {
    if (reconcileSwitch()) {
      const { applied } = await reconcileOrgs(db, objects, orgIds, {
        apply: true,
        now,
        maxCandidates: SWEEP_RECONCILE_MAX_CANDIDATES,
        ...reconcileLogging(log),
      });
      log(
        `  Reconcile: deleted ${applied.prefixes} prefix(es) and ${applied.inputs} input(s); skipped ${applied.skipped}.`,
      );
    } else {
      log("  Reconcile skipped: PURGE_RECONCILE=off.");
    }
  } catch (error) {
    failed++;
    log(`  reconcile failed (${reason(error)})`);
  }
  try {
    const { deleted } = await expireCache(objects, orgIds, {
      apply: true,
      now,
      onPlan: (plan) => {
        for (const line of describeCachePlan(plan)) log(line);
      },
    });
    log(`  Cache expiry: deleted ${deleted} object(s).`);
  } catch (error) {
    failed++;
    log(`  cache expiry failed (${reason(error)})`);
  }
  return failed;
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
        : command === "org"
          ? runOrgPurge(rest)
          : command === "org-expire"
            ? runOrgExpire(rest)
            : main(command, process.argv.includes("--dry-run"));
  run.catch((error: unknown) => {
    console.error(`  x  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
