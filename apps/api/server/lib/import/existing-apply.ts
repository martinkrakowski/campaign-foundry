import type { SqlQuery } from "../db/sql-client.js";
import { getAssetStore, getBriefStore } from "../ports/index.js";
import {
  classifyExisting,
  existingDigest,
  latestBodies,
  refTargetHashes,
  type DigestedCampaign,
  type ExistingCampaign,
  type ExistingFile,
} from "./existing-campaigns.js";
import { importTenant } from "./import-tenant.js";
import { normaliseCampaign, type NormaliseDeps, type NormaliseResult } from "./normalise-step.js";
import type { StepContext } from "./steps.js";

/** One existing class-(P) campaign queued for `apply`, before any write happens. */
export type ExistingReplanItem =
  | {
      readonly campaign: Extract<ExistingCampaign, { readonly state: "normalise" }>;
      readonly body: string;
      readonly files: readonly ExistingFile[];
    }
  | {
      readonly campaign: Extract<ExistingCampaign, { readonly state: "refused" }>;
    };

/** Pre-write class-(P) replan and second digest (PT-8e 1, D225, D228). */
export interface ExistingReplan {
  readonly items: readonly ExistingReplanItem[];
  readonly normaliseCount: number;
  readonly digest: string;
}

/** Tally returned by {@link applyExistingNormalise}. */
export interface ExistingNormaliseCounts {
  readonly normalised: number;
  readonly refused: number;
  readonly assetsMinted: number;
  readonly partial: boolean;
  readonly normalisedSlugs: ReadonlySet<string>;
}

/**
 * Re-classify live campaigns in `ctx.orgId` and compute the class-(P) second digest
 * before `apply` opens `--result` or writes any row or object.
 */
export async function replanExisting(db: SqlQuery, ctx: StepContext): Promise<ExistingReplan> {
  const items: ExistingReplanItem[] = [];
  const digested: DigestedCampaign[] = [];
  for (const row of await latestBodies(db, ctx.orgId)) {
    const found = classifyExisting(ctx, row);
    if (found === undefined) continue;
    if (found.state === "refused") {
      items.push({ campaign: found });
      continue;
    }
    const files = refTargetHashes(ctx, found);
    digested.push({ slug: found.slug, revision: found.revision, files });
    items.push({ campaign: found, body: row.body, files });
  }
  return {
    items,
    normaliseCount: digested.length,
    digest: existingDigest(digested),
  };
}

/**
 * Fail-closed check for `--expect-existing <digest>` (PT-8e 1, D225).
 * Required whenever at least one class-(P) campaign would be normalised; when
 * supplied even on zero campaigns, it must still match `existingDigest([])`.
 */
export function checkExistingDigest(
  replanned: ExistingReplan,
  expectExisting?: string,
): string | undefined {
  if (expectExisting !== undefined) {
    if (replanned.digest !== expectExisting) {
      return `--expect-existing ${expectExisting} does not match the existing-campaigns digest ${replanned.digest}`;
    }
    return undefined;
  }
  if (replanned.normaliseCount > 0) {
    return `apply needs --expect-existing <digest> when class-(P) campaigns would be normalised (digest ${replanned.digest})`;
  }
  return undefined;
}

async function countCampaignDrafts(
  db: SqlQuery,
  orgId: string,
  campaignId: string,
): Promise<number> {
  const { rows } = await db.query<{ drafts: number }>(
    `select count(*)::int as drafts from draft where org_id = $1 and campaign_id = $2`,
    [orgId, campaignId],
  );
  return rows[0]?.drafts ?? 0;
}

async function normaliseOneItem(
  deps: NormaliseDeps,
  ctx: StepContext,
  item: ExistingReplanItem,
): Promise<NormaliseResult> {
  if (item.campaign.state === "refused") {
    return {
      slug: item.campaign.slug,
      campaignId: item.campaign.campaignId,
      status: "refused",
      refusal: "failed",
      reason: item.campaign.reason,
      minted: { assets: [] },
      notImported: [],
    };
  }
  const normalised = item as Extract<
    ExistingReplanItem,
    { readonly campaign: { readonly state: "normalise" } }
  >;
  const expected = new Map(normalised.files.map((file) => [file.ref, file.sha256]));
  return normaliseCampaign(deps, ctx, {
    campaign: normalised.campaign,
    body: normalised.body,
    expected,
  });
}

/**
 * Batch-normalise every existing class-(P) campaign found by {@link replanExisting}
 * in `slug` order (D228). Pre-write refusals and conflicts increment `refused`;
 * mid-write failures/conflicts after minting an asset mark `partial = true` and
 * keep `minted.assets` for rollback (D229).
 */
export async function applyExistingNormalise(
  db: SqlQuery,
  ctx: StepContext,
  replanned: ExistingReplan,
  onEntry: (entry: NormaliseResult) => Promise<void>,
  stores?: Partial<NormaliseDeps>,
): Promise<ExistingNormaliseCounts> {
  const tenant = importTenant(ctx.orgId);
  const deps: NormaliseDeps = {
    briefs: stores?.briefs ?? getBriefStore(tenant),
    assets: stores?.assets ?? getAssetStore(tenant),
    draftCount: stores?.draftCount ?? ((id) => countCampaignDrafts(db, ctx.orgId, id)),
  };
  let normalised = 0;
  let refused = 0;
  let assetsMinted = 0;
  let partial = false;
  const slugs = new Set<string>();
  for (const item of replanned.items) {
    const result = await normaliseOneItem(deps, ctx, item);
    assetsMinted += result.minted.assets.length;
    if (result.status === "normalised") {
      normalised++;
      slugs.add(result.slug);
    } else if (result.minted.assets.length > 0) {
      partial = true;
    } else {
      refused++;
    }
    await onEntry(result);
  }
  return { normalised, refused, assetsMinted, partial, normalisedSlugs: slugs };
}
