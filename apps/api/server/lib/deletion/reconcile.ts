import {
  objectKeyProblem,
  type ListedObject,
  type ObjectKey,
  type ObjectStorePort,
  type PublicAdMediaPort,
} from "@campaignfoundry/CampaignOrchestration";
import type { SqlClient, SqlQuery } from "../db/sql-client.js";
import { publishedClipLockName } from "../ports/pg-published-clip-store.js";
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
 * org (PT-9h2). The listing is now read page by page into one aggregate per
 * campaign.
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

/** What the decision needs about one campaign's objects, and nothing else. */
interface CampaignListing {
  /** Every object listed under the campaign's prefix. */
  objects: number;
  /** True once ANY object is not older than the threshold. */
  fresh: boolean;
  /** The asset ids of its input objects that ARE older than the threshold. */
  readonly oldInputs: string[];
}

/**
 * Read the org's listing page by page into one aggregate per campaign, parsing
 * EVERY key, so one odd key on ANY page throws before anything is decided. A
 * campaign's objects may arrive on different pages and in any order: the
 * aggregate is only read once the last page has been folded in.
 */
async function aggregateListing(
  root: ObjectKey,
  pages: AsyncIterable<readonly ListedObject[]>,
  now: number,
): Promise<Map<string, CampaignListing>> {
  const byCampaign = new Map<string, CampaignListing>();
  for await (const page of pages) {
    for (const object of page) {
      const { campaignId, assetId } = parseKey(root, object);
      const group = byCampaign.get(campaignId) ?? { objects: 0, fresh: false, oldInputs: [] };
      const old = now - object.lastModified.getTime() > ORPHAN_MIN_AGE_MS;
      group.objects++;
      if (!old) group.fresh = true;
      if (old && assetId !== undefined) group.oldInputs.push(assetId);
      byCampaign.set(campaignId, group);
    }
  }
  return byCampaign;
}

/**
 * D239, read only: what the reconciler WOULD delete for one org. Reads under
 * `org/<org>/campaign/` only (never `cache/`, never another org) page by page
 * into one aggregate per campaign via `listPages`, parses EVERY key on ANY
 * page before deciding anything, and reads the rows AFTER the whole listing,
 * only for the campaigns the listing named and at most `ROW_QUERY_CHUNK` at a
 * time.
 */
export async function planReconcile(
  db: SqlQuery,
  store: ObjectStorePort,
  orgId: string,
  now: number,
): Promise<ReconcilePlan> {
  const root = orgCampaignsPrefix(orgId);
  const byCampaign = await aggregateListing(root, store.listPages(root), now);

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

  const prefixes: { campaignId: string; objects: number }[] = [];
  const inputs: { campaignId: string; assetId: string }[] = [];
  for (const [campaignId, group] of byCampaign) {
    const state = tombstoned.get(campaignId);
    if (state === undefined) {
      if (!group.fresh) {
        prefixes.push({ campaignId, objects: group.objects });
      }
      continue;
    }
    if (state) continue;
    for (const assetId of group.oldInputs) {
      if (!assetRefs.has(`${campaignId}/${assetId}`)) inputs.push({ campaignId, assetId });
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

/**
 * The shape of a PUBLIC ad-media key: `{org}/{32-hex-random}/{64-hex-hash}.mp4`
 * — the same three segments `PublicAdMediaStore` mints, spelled out here so a
 * listed key that does not match is an abort, never a delete.
 */
const PUBLIC_MEDIA_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\/[0-9a-f]{32}\/[0-9a-f]{64}\.mp4$/;

/** What the public-media reconcile WOULD delete for one org. */
export interface PublicMediaReconcilePlan {
  readonly orgId: string;
  /** Public keys with no `published_clip` row, older than `ORPHAN_MIN_AGE_MS`. */
  readonly keys: readonly ObjectKey[];
}

/** One public candidate's outcome, reported as it happens. */
export interface PublicMediaReconcileStep {
  readonly kind: "public-clip";
  readonly key: ObjectKey;
  readonly outcome: "deleted" | "skipped";
}

export interface PublicMediaReconcileResult {
  readonly plans: readonly PublicMediaReconcilePlan[];
  readonly applied: { readonly deleted: number; readonly skipped: number };
}

export interface PublicMediaReconcileOptions {
  readonly apply: boolean;
  readonly now: () => number;
  /** Once per org, in order, after EVERY org is planned and before the first delete. */
  readonly onPlan?: (plan: PublicMediaReconcilePlan) => void;
  /** After each delete that completed, and for each candidate skipped because a row had appeared. */
  readonly onStep?: (step: PublicMediaReconcileStep) => void;
  /**
   * Refuse, before the first delete and only when applying, when the plans of
   * ALL orgs hold more candidates than this. Absent means no cap.
   */
  readonly maxCandidates?: number;
}

/** Why `key` may not be acted on, or undefined when it is a candidate's shape. */
function publicKeyProblem(key: ObjectKey, orgId: string): string | undefined {
  if (!key.startsWith(`${orgId}/`)) {
    return "a listed key is outside the org's own prefix";
  }
  // The strict published-key shape below is narrower than the generic key rules
  // (no traversal, empty or absolute segments can match it), so no separate check.
  if (!PUBLIC_MEDIA_KEY_PATTERN.test(key)) {
    return "a listed key is outside the published key shape";
  }
  return undefined;
}

/**
 * D239, read only: the public objects of ONE org that a crash between
 * `publish()` and the ledger `record()` orphaned. Streams the listing page by
 * page, validates EVERY key on ANY page before deciding anything (an odd key
 * aborts before anything is decided), keeps only objects older than
 * `ORPHAN_MIN_AGE_MS` — an in-flight publish is never a candidate — and then
 * reads `published_clip` for the keys that remain, at most `ROW_QUERY_CHUNK`
 * at a time. The plan holds only keys the ledger does not know.
 */
export async function planPublicMediaReconcile(
  db: SqlQuery,
  media: PublicAdMediaPort,
  orgId: string,
  now: number,
): Promise<PublicMediaReconcilePlan> {
  const candidates: ObjectKey[] = [];
  for await (const page of media.listPages(orgId)) {
    for (const object of page) {
      const problem = publicKeyProblem(object.key, orgId);
      if (problem !== undefined) {
        throw new Error(`public-media reconcile aborted, nothing deleted: ${problem}.`);
      }
      if (now - object.lastModified.getTime() > ORPHAN_MIN_AGE_MS) candidates.push(object.key);
    }
  }

  const orphaned: ObjectKey[] = [];
  for (let start = 0; start < candidates.length; start += ROW_QUERY_CHUNK) {
    const chunk = candidates.slice(start, start + ROW_QUERY_CHUNK);
    const { rows } = await db.query<{ key: string }>(
      `select key from published_clip where org_id = $1 and key = any($2::text[])`,
      [orgId, chunk],
    );
    const recorded = new Set(rows.map((row) => row.key));
    for (const key of chunk) {
      if (!recorded.has(key)) orphaned.push(key);
    }
  }
  return { orgId, keys: orphaned };
}

/** The lines the reconcile logs for one org's public-media plan. */
export function describePublicMediaPlan(plan: PublicMediaReconcilePlan): string[] {
  return [
    `  public media org ${plan.orgId}: ${plan.keys.length} orphan clip(s)`,
    ...plan.keys.map((key) => `    public clip ${key}`),
  ];
}

/** The line logged for one public step, as it completes. */
export function describePublicMediaStep(step: PublicMediaReconcileStep): string {
  return step.outcome === "deleted"
    ? `  deleted ${step.kind} ${step.key}`
    : `  skipped ${step.kind} ${step.key} (a row appeared)`;
}

/**
 * Delete what the public-media plan names. Each key is handled in its own
 * transaction under the per-key advisory lock the ledger's `record` also takes:
 * the ledger row is re-read and, only if none exists, the object is removed
 * before the lock is released. A publisher that pauses after `publish()` for
 * longer than the grace period therefore meets one of two outcomes: its row
 * committed first, so this pass skips the key; or this pass removed the object
 * first, and the publisher's `record` (which re-checks the object under the
 * same lock) refuses instead of writing a row for a missing object. There is
 * no interleaving in which a row names a removed object.
 * `onStep` hears each outcome AFTER it happened, so an interrupted run leaves a
 * record of exactly what was removed.
 */
export async function applyPublicMediaReconcilePlan(
  db: SqlClient,
  media: PublicAdMediaPort,
  plan: PublicMediaReconcilePlan,
  onStep?: (step: PublicMediaReconcileStep) => void,
): Promise<{ deleted: number; skipped: number }> {
  let deleted = 0;
  let skipped = 0;
  for (const key of plan.keys) {
    const outcome = await db.transaction(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        publishedClipLockName(plan.orgId, key),
      ]);
      const { rows } = await tx.query(
        `select 1 from published_clip where org_id = $1 and key = $2`,
        [plan.orgId, key],
      );
      if (rows.length > 0) return "skipped" as const;
      await media.remove(key);
      return "deleted" as const;
    });
    if (outcome === "skipped") skipped++;
    else deleted++;
    onStep?.({ kind: "public-clip", key, outcome });
  }
  return { deleted, skipped };
}

/**
 * Plan EVERY org first, report each plan, then (only when `apply`) delete: one
 * odd key in any org aborts before the first delete anywhere, and so does a
 * total over `maxCandidates`. Dry run is the default of every caller; nothing
 * is deleted unless `apply` is the literal `true`.
 */
export async function reconcilePublicMediaOrgs(
  db: SqlClient,
  media: PublicAdMediaPort,
  orgIds: readonly string[],
  options: PublicMediaReconcileOptions,
): Promise<PublicMediaReconcileResult> {
  const plans: PublicMediaReconcilePlan[] = [];
  for (const orgId of orgIds)
    plans.push(await planPublicMediaReconcile(db, media, orgId, options.now()));
  for (const plan of plans) options.onPlan?.(plan);
  if (!options.apply) return { plans, applied: { deleted: 0, skipped: 0 } };
  const candidates = plans.reduce((sum, plan) => sum + plan.keys.length, 0);
  if (options.maxCandidates !== undefined && candidates > options.maxCandidates) {
    throw new Error(
      `public-media reconcile refused, nothing deleted: ${candidates} candidates exceed the cap of ${options.maxCandidates}.`,
    );
  }
  let deleted = 0;
  let skipped = 0;
  for (const plan of plans) {
    const counts = await applyPublicMediaReconcilePlan(db, media, plan, options.onStep);
    deleted += counts.deleted;
    skipped += counts.skipped;
  }
  return { plans, applied: { deleted, skipped } };
}
