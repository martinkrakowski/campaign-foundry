import {
  objectKeyProblem,
  type ListedObject,
  type ObjectKey,
  type ObjectStorePort,
} from "@campaignfoundry/CampaignOrchestration";
import type { SqlQuery } from "../db/sql-client.js";
import { campaignPrefix, inputKey, orgCampaignsPrefix } from "../object-store/object-keys.js";

/**
 * D239: an orphan is only ever acted on once it is MORE than this old, so an
 * upload or a render that is still being written (its row not yet committed, a
 * clock a little skewed) is never mistaken for one. The age compares this
 * host's clock with the store's LastModified: a store clock BEHIND this host by
 * close to an hour would age a fresh object. NTP on both is an operator
 * precondition; a listing cannot detect it.
 */
export const ORPHAN_MIN_AGE_MS = 60 * 60_000;

/**
 * Campaign ids per row query. The plan asks the database about the campaigns
 * the listing named, at most this many at a time, never about every row of the
 * org (PT-9h2). The listing itself is still one array per org until the port
 * pages it (PT-9h3).
 */
export const ROW_QUERY_CHUNK = 500;

const UUID_LOWER = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** What may follow `org/<org>/campaign/`: `<uuid>/inputs/<uuid>`, or `<uuid>/(renders|packages)/<key>`. */
const KEY_TAIL = new RegExp(
  `^(${UUID_LOWER})/(?:inputs/(${UUID_LOWER})|(?:renders|packages)/[A-Za-z0-9._/-]+)$`,
);

export interface ReconcilePlan {
  readonly orgId: string;
  /** Campaign prefixes with no `campaign` row, every object older than the threshold. */
  readonly prefixes: readonly { readonly campaignId: string; readonly objects: number }[];
  /** Input objects of a live campaign with no `asset` row, older than the threshold. */
  readonly inputs: readonly { readonly campaignId: string; readonly assetId: string }[];
}

export interface AppliedCounts {
  readonly prefixes: number;
  readonly inputs: number;
  /** Candidates a row had appeared for between the plan and the delete. */
  readonly skipped: number;
}

export interface ReconcileResult {
  readonly plans: readonly ReconcilePlan[];
  readonly applied: AppliedCounts;
}

/** One candidate's outcome, reported as it happens: `key` is REBUILT from validated ids. */
export interface ReconcileStep {
  readonly kind: "prefix" | "input";
  readonly key: string;
  readonly outcome: "deleted" | "skipped";
}

export interface ReconcileOptions {
  readonly apply: boolean;
  readonly now: () => number;
  /** Once per org, in order, after EVERY org is planned and before the first delete. */
  readonly onPlan?: (plan: ReconcilePlan) => void;
  /** After each delete that completed, and for each candidate skipped because a row had appeared. */
  readonly onStep?: (step: ReconcileStep) => void;
  /**
   * Refuse, before the first delete and only when applying, when the plans of
   * ALL orgs hold more candidates than this (a database that looks wrong makes
   * every prefix an orphan). Absent means no cap: the operator's CLI.
   */
  readonly maxCandidates?: number;
}

function parseKey(root: ObjectKey, object: ListedObject): { campaignId: string; assetId?: string } {
  const tail = object.key.startsWith(root) ? object.key.slice(root.length) : undefined;
  const match = tail === undefined ? null : KEY_TAIL.exec(tail);
  if (match === null || objectKeyProblem(object.key) !== undefined) {
    throw new Error(
      "reconcile aborted, nothing deleted: a listed key is outside the object key alphabet.",
    );
  }
  return { campaignId: match[1]!, assetId: match[2] };
}

/**
 * Group a listing by campaign, keeping only what the decision needs (the age of
 * each object and, for an input, its asset id) and parsing EVERY key, so one
 * odd key throws before anything is decided.
 */
function groupListing(
  root: ObjectKey,
  listed: readonly ListedObject[],
): Map<string, { object: { readonly lastModified: Date }; assetId?: string }[]> {
  const byCampaign = new Map<
    string,
    { object: { readonly lastModified: Date }; assetId?: string }[]
  >();
  for (const object of listed) {
    const { campaignId, assetId } = parseKey(root, object);
    const group = byCampaign.get(campaignId) ?? [];
    group.push({ object: { lastModified: object.lastModified }, assetId });
    byCampaign.set(campaignId, group);
  }
  return byCampaign;
}

/**
 * D239, read only: what the reconciler WOULD delete for one org. Lists under
 * `org/<org>/campaign/` only (never `cache/`, never another org), parses EVERY
 * key before deciding anything, and reads the rows AFTER the listing, only for
 * the campaigns the listing named and at most `ROW_QUERY_CHUNK` at a time.
 */
export async function planReconcile(
  db: SqlQuery,
  store: ObjectStorePort,
  orgId: string,
  now: number,
): Promise<ReconcilePlan> {
  const root = orgCampaignsPrefix(orgId);
  const byCampaign = groupListing(root, await store.list(root));

  const ids = [...byCampaign.keys()];
  const tombstoned = new Map<string, boolean>();
  const assetRefs = new Set<string>();
  for (let start = 0; start < ids.length; start += ROW_QUERY_CHUNK) {
    const chunk = ids.slice(start, start + ROW_QUERY_CHUNK);
    const campaigns = await db.query<{ id: string; tombstoned: boolean }>(
      `select id::text as id, deleted_at is not null as tombstoned from campaign where org_id = $1 and id = any($2::uuid[])`,
      [orgId, chunk],
    );
    for (const row of campaigns.rows) tombstoned.set(row.id, row.tombstoned);
    const assets = await db.query<{ campaign_id: string; id: string }>(
      `select campaign_id::text as campaign_id, id::text as id from asset where org_id = $1 and campaign_id = any($2::uuid[])`,
      [orgId, chunk],
    );
    for (const row of assets.rows) assetRefs.add(`${row.campaign_id}/${row.id}`);
  }

  const isOld = (object: { readonly lastModified: Date }): boolean =>
    now - object.lastModified.getTime() > ORPHAN_MIN_AGE_MS;
  const prefixes: { campaignId: string; objects: number }[] = [];
  const inputs: { campaignId: string; assetId: string }[] = [];
  for (const [campaignId, group] of byCampaign) {
    const state = tombstoned.get(campaignId);
    if (state === undefined) {
      if (group.every(({ object }) => isOld(object))) {
        prefixes.push({ campaignId, objects: group.length });
      }
      continue;
    }
    if (state) continue;
    for (const { object, assetId } of group) {
      if (assetId !== undefined && !assetRefs.has(`${campaignId}/${assetId}`) && isOld(object)) {
        inputs.push({ campaignId, assetId });
      }
    }
  }
  return { orgId, prefixes, inputs };
}

/** The lines `reconcile` logs for one org's plan: a header, then one line per candidate. */
export function describePlan(plan: ReconcilePlan): string[] {
  return [
    `  org ${plan.orgId}: ${plan.prefixes.length} orphan prefix(es), ${plan.inputs.length} orphan input(s)`,
    ...plan.prefixes.map(
      (prefix) =>
        `    prefix ${campaignPrefix(plan.orgId, prefix.campaignId)} (${prefix.objects} object(s))`,
    ),
    ...plan.inputs.map(
      (input) => `    input ${inputKey(plan.orgId, input.campaignId, input.assetId)}`,
    ),
  ];
}

/** The line logged for one step, as it completes. */
export function describeStep(step: ReconcileStep): string {
  return step.outcome === "deleted"
    ? `  deleted ${step.kind} ${step.key}`
    : `  skipped ${step.kind} ${step.key} (a row appeared)`;
}

async function campaignExists(db: SqlQuery, orgId: string, campaignId: string): Promise<boolean> {
  const { rows } = await db.query(`select 1 from campaign where org_id = $1 and id = $2::uuid`, [
    orgId,
    campaignId,
  ]);
  return rows.length > 0;
}

async function assetExists(
  db: SqlQuery,
  orgId: string,
  campaignId: string,
  assetId: string,
): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from asset where org_id = $1 and campaign_id = $2::uuid and id = $3::uuid`,
    [orgId, campaignId, assetId],
  );
  return rows.length > 0;
}

/**
 * Delete what `plan` names, re-checking each candidate's row first. Keys are
 * REBUILT from the plan's validated ids (`campaignPrefix`, `inputKey`), never
 * taken from the listing. `onStep` hears each outcome AFTER it happened, so an
 * interrupted run leaves a record of exactly what was removed.
 */
export async function applyReconcilePlan(
  db: SqlQuery,
  store: ObjectStorePort,
  plan: ReconcilePlan,
  onStep?: (step: ReconcileStep) => void,
): Promise<AppliedCounts> {
  let prefixes = 0;
  let inputs = 0;
  let skipped = 0;
  for (const prefix of plan.prefixes) {
    if (await campaignExists(db, plan.orgId, prefix.campaignId)) {
      skipped++;
      onStep?.({
        kind: "prefix",
        key: campaignPrefix(plan.orgId, prefix.campaignId),
        outcome: "skipped",
      });
      continue;
    }
    await store.deletePrefix(campaignPrefix(plan.orgId, prefix.campaignId));
    prefixes++;
    onStep?.({
      kind: "prefix",
      key: campaignPrefix(plan.orgId, prefix.campaignId),
      outcome: "deleted",
    });
  }
  for (const input of plan.inputs) {
    if (await assetExists(db, plan.orgId, input.campaignId, input.assetId)) {
      skipped++;
      onStep?.({
        kind: "input",
        key: inputKey(plan.orgId, input.campaignId, input.assetId),
        outcome: "skipped",
      });
      continue;
    }
    await store.delete(inputKey(plan.orgId, input.campaignId, input.assetId));
    inputs++;
    onStep?.({
      kind: "input",
      key: inputKey(plan.orgId, input.campaignId, input.assetId),
      outcome: "deleted",
    });
  }
  return { prefixes, inputs, skipped };
}

/**
 * Plan EVERY org first, report each plan, then (only when `apply`) delete: one
 * odd key in any org aborts before the first delete anywhere, and so does a
 * total over `maxCandidates`. Dry run is the default of every caller; nothing
 * is deleted unless `apply` is the literal `true`.
 */
export async function reconcileOrgs(
  db: SqlQuery,
  store: ObjectStorePort,
  orgIds: readonly string[],
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const plans: ReconcilePlan[] = [];
  for (const orgId of orgIds) plans.push(await planReconcile(db, store, orgId, options.now()));
  for (const plan of plans) options.onPlan?.(plan);
  if (!options.apply) return { plans, applied: { prefixes: 0, inputs: 0, skipped: 0 } };
  const candidates = plans.reduce(
    (sum, plan) => sum + plan.prefixes.length + plan.inputs.length,
    0,
  );
  if (options.maxCandidates !== undefined && candidates > options.maxCandidates) {
    throw new Error(
      `reconcile refused, nothing deleted: ${candidates} candidates exceed the cap of ${options.maxCandidates}.`,
    );
  }
  let prefixes = 0;
  let inputs = 0;
  let skipped = 0;
  for (const plan of plans) {
    const counts = await applyReconcilePlan(db, store, plan, options.onStep);
    prefixes += counts.prefixes;
    inputs += counts.inputs;
    skipped += counts.skipped;
  }
  return { plans, applied: { prefixes, inputs, skipped } };
}
