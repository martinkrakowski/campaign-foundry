import type { StorageScope } from "./run-environment.js";
import type { StoredBrief } from "./ports/brief-store.port.js";
import { getAssetStore, getBriefStore, getReportStore } from "./ports/index.js";
import type { TenantContext } from "./tenant.js";

/**
 * The route-side half of D166 item 3's permission check: `owner`/`admin` may
 * assign any team, anyone else only one of their own — using the tenant's own
 * `roles`/`teamIds`, with no store call. It is deliberately not the whole
 * check: `PgBriefStore`'s `assertTeamInOrg` still refuses a team from another
 * org (or a typo'd id), which this cannot see. Shared by the brief create and
 * replace routes so the rule reads once.
 *
 * `teamId: null` (D166 item 5) means clearing an assigned team back to
 * org-wide — which WIDENS visibility from one team to the whole org, unlike
 * assigning a specific team, which only ever narrows it to teams the caller
 * already belongs to. That is a more sensitive move than a plain member's own
 * "one of my own teams" grant covers, so clearing is `owner`/`admin` only.
 */
export function canAssignTeam(tenant: TenantContext, teamId: string | null): boolean {
  if (tenant.roles.includes("owner") || tenant.roles.includes("admin")) return true;
  return teamId !== null && tenant.teamIds.includes(teamId);
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

/**
 * Refuse (404) a source campaign id that EXISTS but is hidden from the caller
 * by team (D166 item 2) — never one that is merely absent. "Save as…" and
 * duplicate copy brief-scoped assets by directory name
 * (`assets/inputs/<id>/*`), and on the filesystem backend that name need
 * never have been a saved campaign at all (a demo asset dropped straight into
 * the directory, say) — `campaignVisibility` answers "absent" for that case,
 * same as for a typo, and this must let it through unchanged. What it must
 * catch is a request naming another team's real, existing campaign as an
 * asset source to exfiltrate its files into the caller's own campaign.
 */
export async function assertSourceVisible(scope: StorageScope, campaignId: string): Promise<void> {
  const briefStore = getBriefStore(scope);
  // Same L1 reasoning as campaignKnown: skip the call entirely on a backend
  // that can never answer "hidden" (the fs backend, item 5), rather than
  // paying for a directory scan whose answer this can never use.
  if (briefStore.supportsTeams && (await briefStore.campaignVisibility(campaignId)) === "hidden") {
    throw new CampaignNotFoundError(campaignId);
  }
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
 * proves the caller may see THIS campaign. Checked first, via the port's own
 * `campaignVisibility`, but only when `supportsTeams` says the backend can
 * ever answer "hidden" at all (Postgres) — the filesystem backend's
 * `campaignVisibility` would answer correctly regardless (never "hidden",
 * item 5), but calling it costs a full directory scan on every read, which is
 * exactly what L1 (below) exists to avoid; `supportsTeams` lets this skip the
 * call rather than the correctness. A genuinely unsaved draft (no campaign
 * row at all) answers "absent", not "hidden", so it still falls through to
 * the report/asset fast path exactly as before.
 *
 * D166 (PT-2c, item 1): this check is deliberately NOT wrapped in a
 * try/catch that folds a failure into `readFailure` and keeps going — a
 * visibility check that cannot be decided must fail CLOSED. Swallowing a
 * `campaignVisibility` storage failure here and falling through to the
 * report/asset fast path let it grant access to a campaign that failure
 * itself made unverifiable: the report/asset shortcut only proves something
 * exists in the ORG's scope, never that THIS caller's team may see it. So a
 * `campaignVisibility` rejection propagates straight out of this function,
 * uncaught, before either fast path ever runs.
 */
export async function campaignKnown(
  scope: StorageScope,
  campaignId: string,
  kind?: KnownResourceKind,
): Promise<void> {
  let readFailure: unknown;

  const briefStore = getBriefStore(scope);
  if (briefStore.supportsTeams && (await briefStore.campaignVisibility(campaignId)) === "hidden") {
    throw new CampaignNotFoundError(campaignId);
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
