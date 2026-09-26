import type { StorageScope } from "./run-environment.js";
import type { StoredBrief } from "./ports/brief-store.port.js";
import { getAssetStore, getBriefStore, getReportStore } from "./ports/index.js";
import { PgBriefStore } from "./ports/pg-brief-store.js";
import type { TenantContext } from "./tenant.js";

/**
 * The route-side half of D166 item 3's permission check: `owner`/`admin` may
 * assign any team, anyone else only one of their own — using the tenant's own
 * `roles`/`teamIds`, with no store call. It is deliberately not the whole
 * check: `PgBriefStore`'s `assertTeamInOrg` still refuses a team from another
 * org (or a typo'd id), which this cannot see. Shared by the brief create and
 * replace routes so the rule reads once.
 */
export function canAssignTeam(tenant: TenantContext, teamId: string): boolean {
  return tenant.roles.includes("owner") || tenant.roles.includes("admin")
    ? true
    : tenant.teamIds.includes(teamId);
}

/**
 * Thrown when an operation is requested on a campaign that does not exist
 * or does not belong to the caller's tenant (D166 / PT-2b).
 * Carries statusCode 404 so Nitro / h3 maps it to HTTP 404 Not Found.
 */
export class CampaignNotFoundError extends Error {
  readonly statusCode = 404;
  readonly status = 404;
  readonly campaignId: string;

  constructor(campaignId: string) {
    super(`Campaign "${campaignId}" not found`);
    this.name = "CampaignNotFoundError";
    this.campaignId = campaignId;
  }
}

/**
 * Assert that the campaign exists and belongs to the given tenant scope.
 * Built on the brief store's existing findBriefById (fs: the brief exists
 * under the tenant root; pg: a campaign row for org_id).
 *
 * Throws a typed CampaignNotFoundError (HTTP 404) if the campaign is not found.
 */
export async function assertOwnedCampaign(
  scope: StorageScope,
  campaignId: string,
): Promise<StoredBrief> {
  const brief = await getBriefStore(scope).findBriefById(campaignId);
  if (!brief) {
    throw new CampaignNotFoundError(campaignId);
  }
  return brief;
}

export type KnownResourceKind = "report" | "asset";

/**
 * Assert that a campaign is known to the caller's scope (Rule A / PT-2b).
 *
 * Answers 404 (CampaignNotFoundError) only when the campaign has NEITHER
 * a stored brief NOR anything in the caller's scope:
 * - for "report" (result and decisions): a report in the caller's scope;
 * - for "asset" (assets list): any asset in the caller's scope;
 * - when kind is omitted: either a report or an asset.
 *
 * Checks the cheap scoped read first (report or asset existence) and falls back
 * to findBriefById only when it misses, so the fs full-directory brief scan does
 * not run on every read (L1).
 *
 * Neither `getRevision` nor `listAssets` ever throws to say "not found" — both
 * ports answer that with `undefined` / an empty list. A rejection is always a
 * genuine storage failure (a dropped pg connection, an EACCES). Such a failure
 * still falls back to the brief check (a flaky report read should not fail an
 * otherwise-known campaign), but if the brief check *also* comes up empty —
 * true for an unsaved draft, which by design has no stored brief — the
 * failure is surfaced instead of being swallowed into a false 404. Answering
 * 404 there would tell the caller the campaign does not exist when the truth
 * is that this scope could not be checked, and the web client treats that 404
 * as "no run" / "no decisions" — a storage failure must not look like an
 * unsaved draft's work having disappeared.
 *
 * D166 (PT-2c, item 4): a campaign hidden from the caller by its team must
 * read as unknown even when a report or asset exists in the org's scope —
 * neither store carries a team column, so their existence alone no longer
 * proves the caller may see THIS campaign. Checked first, Postgres-only
 * (`hiddenFromCaller`; the fs backend has no teams, item 5): a database
 * failure there folds into the same `readFailure` the report/asset checks
 * use below rather than becoming a false 404, and a genuinely unsaved draft
 * (no campaign row at all) is not "hidden" — it falls through to the
 * report/asset fast path exactly as before.
 */
export async function campaignKnown(
  scope: StorageScope,
  campaignId: string,
  kind?: KnownResourceKind,
): Promise<void> {
  let readFailure: unknown;

  const briefStore = getBriefStore(scope);
  if (briefStore instanceof PgBriefStore) {
    try {
      if (await briefStore.hiddenFromCaller(campaignId)) {
        throw new CampaignNotFoundError(campaignId);
      }
    } catch (error) {
      if (error instanceof CampaignNotFoundError) throw error;
      readFailure ??= error;
    }
  }

  const reportKnown = async (): Promise<boolean> => {
    try {
      const revision = await getReportStore(scope).getRevision(campaignId);
      return revision !== undefined;
    } catch (error) {
      readFailure ??= error;
      return false;
    }
  };

  const assetKnown = async (): Promise<boolean> => {
    try {
      const assets = await getAssetStore(scope).listAssets(campaignId);
      return assets.length > 0;
    } catch (error) {
      readFailure ??= error;
      return false;
    }
  };

  if (kind === "asset") {
    if (await assetKnown()) return;
  } else {
    if (await reportKnown()) return;
    if (kind === undefined && (await assetKnown())) return;
  }

  const brief = await briefStore.findBriefById(campaignId);
  if (brief) return;

  if (readFailure !== undefined) throw readFailure;
  throw new CampaignNotFoundError(campaignId);
}
