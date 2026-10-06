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
 * D239, read only: what the reconciler WOULD delete for one org. Lists under
 * `org/<org>/campaign/` only (never `cache/`, never another org), parses EVERY
 * key before deciding anything, and reads the rows AFTER the listing.
 */
export async function planReconcile(
  db: SqlQuery,
  store: ObjectStorePort,
  orgId: string,
  now: number,
): Promise<ReconcilePlan> {
  const root = orgCampaignsPrefix(orgId);
  const listed = await store.list(root);
  const byCampaign = new Map<string, { object: ListedObject; assetId?: string }[]>();
  for (const object of listed) {
    const { campaignId, assetId } = parseKey(root, object);
    const group = byCampaign.get(campaignId) ?? [];
    group.push({ object, assetId });
    byCampaign.set(campaignId, group);
  }

  const campaigns = await db.query<{ id: string; tombstoned: boolean }>(
    `select id::text as id, deleted_at is not null as tombstoned from campaign where org_id = $1`,
    [orgId],
  );
  const tombstoned = new Map(campaigns.rows.map((row) => [row.id, row.tombstoned]));
  const assets = await db.query<{ campaign_id: string; id: string }>(
    `select campaign_id::text as campaign_id, id::text as id from asset where org_id = $1`,
    [orgId],
  );
  const assetRefs = new Set(assets.rows.map((row) => `${row.campaign_id}/${row.id}`));

  const isOld = (object: ListedObject): boolean =>
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
 * taken from the listing.
 */
export async function applyReconcilePlan(
  db: SqlQuery,
  store: ObjectStorePort,
  plan: ReconcilePlan,
): Promise<AppliedCounts> {
  let prefixes = 0;
  let inputs = 0;
  let skipped = 0;
  for (const prefix of plan.prefixes) {
    if (await campaignExists(db, plan.orgId, prefix.campaignId)) {
      skipped++;
      continue;
    }
    await store.deletePrefix(campaignPrefix(plan.orgId, prefix.campaignId));
    prefixes++;
  }
  for (const input of plan.inputs) {
    if (await assetExists(db, plan.orgId, input.campaignId, input.assetId)) {
      skipped++;
      continue;
    }
    await store.delete(inputKey(plan.orgId, input.campaignId, input.assetId));
    inputs++;
  }
  return { prefixes, inputs, skipped };
}

/**
 * Plan EVERY org first, then (only when `apply`) delete: one odd key in any org
 * aborts before the first delete anywhere. Dry run is the default of every
 * caller; nothing is deleted unless `apply` is the literal `true`.
 */
export async function reconcileOrgs(
  db: SqlQuery,
  store: ObjectStorePort,
  orgIds: readonly string[],
  options: { readonly apply: boolean; readonly now: () => number },
): Promise<ReconcileResult> {
  const plans: ReconcilePlan[] = [];
  for (const orgId of orgIds) plans.push(await planReconcile(db, store, orgId, options.now()));
  if (!options.apply) return { plans, applied: { prefixes: 0, inputs: 0, skipped: 0 } };
  let prefixes = 0;
  let inputs = 0;
  let skipped = 0;
  for (const plan of plans) {
    const counts = await applyReconcilePlan(db, store, plan);
    prefixes += counts.prefixes;
    inputs += counts.inputs;
    skipped += counts.skipped;
  }
  return { plans, applied: { prefixes, inputs, skipped } };
}
