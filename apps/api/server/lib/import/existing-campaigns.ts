import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { dumpBrief, errorMessage } from "@campaignfoundry/shared";
import type { SqlQuery } from "../db/sql-client.js";
import { parseBriefText } from "../load-brief.js";
import { isAssetId } from "../ports/asset-store.port.js";
import { blocksImport, classifyRefs, type RefClassification } from "./classify.js";
import type { StepContext } from "./steps.js";

/**
 * Class (P) of PT-8, D228: campaigns that already exist in the target org and whose
 * LATEST brief version still names a file by path. Everything here is read-only: one
 * `select`, and the `lstat`/read `classifyRefs` does on the source tree.
 */

/** One live campaign's latest version, as stored. */
export interface LatestBody {
  readonly campaignId: string;
  readonly slug: string;
  readonly version: number;
  readonly revision: string;
  readonly body: string;
}

/**
 * The latest `brief_version` of every live campaign of `orgId`, by slug. Read directly,
 * never through `listBriefs`, which drops a body that does not parse (PT-8-2). A
 * tombstoned campaign is not selected: no reader sees it and `rewriteBrief` refuses it.
 */
export async function latestBodies(db: SqlQuery, orgId: string): Promise<LatestBody[]> {
  const { rows } = await db.query<{
    campaign_id: string;
    slug: string;
    version: number;
    revision: string;
    body: string;
  }>(
    `select campaign_id, slug, version, revision, body from (
       select distinct on (c.id) c.id as campaign_id, c.slug, bv.version, bv.revision, bv.body
         from campaign c
         join brief_version bv on bv.campaign_id = c.id
        where c.org_id = $1 and c.deleted_at is null
        order by c.id, bv.version desc
     ) latest
     order by slug`,
    [orgId],
  );
  return rows.map((row) => ({
    campaignId: row.campaign_id,
    slug: row.slug,
    version: row.version,
    revision: row.revision,
    body: row.body,
  }));
}

/** One existing campaign the normalise would rewrite, or cannot. */
export type ExistingCampaign =
  | {
      readonly campaignId: string;
      readonly slug: string;
      readonly revision: string;
      readonly state: "normalise";
      readonly brief: CampaignBrief;
      /** The path refs only, each one clean (`blocksImport` is false). */
      readonly refs: readonly RefClassification[];
    }
  | {
      readonly campaignId: string;
      readonly slug: string;
      readonly revision: string;
      readonly state: "refused";
      readonly reason: string;
    };

function refused(row: LatestBody, reason: string): ExistingCampaign {
  return {
    campaignId: row.campaignId,
    slug: row.slug,
    revision: row.revision,
    state: "refused",
    reason,
  };
}

/**
 * What one latest version is to the normalise: `undefined` when it carries no path
 * ref; `refused` when the body does not parse (the parser's message, F8) or a path
 * ref names a file the import cannot take (D222, `preflight`'s words); else `normalise`.
 * The body is parsed the way `PgBriefStore.listBriefs` parses it.
 */
export function classifyExisting(ctx: StepContext, row: LatestBody): ExistingCampaign | undefined {
  let brief: CampaignBrief;
  try {
    brief = parseBriefText(`${row.slug}.yaml`, dumpBrief(JSON.parse(row.body) as object));
  } catch (error) {
    return refused(row, errorMessage(error));
  }
  const refs = classifyRefs(ctx, {
    slug: row.slug,
    sourcePath: "",
    name: null,
    type: null,
    brief,
    refs: [],
    sample: false,
  }).filter((ref) => !isAssetId(ref.ref));
  if (refs.length === 0) return undefined;
  const blocked = refs.find(blocksImport);
  if (blocked !== undefined) {
    return refused(row, `ref ${JSON.stringify(blocked.ref)}: ${blocked.reason}`);
  }
  const { campaignId, slug, revision } = row;
  return { campaignId, slug, revision, state: "normalise", brief, refs };
}

/** One campaign of the plan's `existingCampaigns` section. */
export type ExistingCampaignPlan =
  | {
      readonly slug: string;
      readonly revision: string;
      readonly state: "normalise";
      readonly refs: readonly RefClassification[];
    }
  | {
      readonly slug: string;
      readonly revision: string;
      readonly state: "refused";
      readonly reason: string;
    };

/** The section: would normalise `normalise` campaigns and `refs` refs; `refused` cannot be. */
export interface ExistingCampaignsPlan {
  readonly campaigns: readonly ExistingCampaignPlan[];
  readonly normalise: number;
  readonly refs: number;
  readonly refused: number;
}

/**
 * `plan`'s read-only section for class (P). Read from the target after the digest was
 * computed, so never part of it (D225). Nothing is written.
 */
export async function planExistingCampaigns(
  db: SqlQuery,
  ctx: StepContext,
): Promise<ExistingCampaignsPlan> {
  const campaigns: ExistingCampaignPlan[] = [];
  let normalise = 0;
  let refs = 0;
  for (const row of await latestBodies(db, ctx.orgId)) {
    const found = classifyExisting(ctx, row);
    if (found === undefined) continue;
    const { slug, revision } = found;
    if (found.state === "normalise") {
      normalise++;
      refs += found.refs.length;
      campaigns.push({ slug, revision, state: "normalise", refs: found.refs });
    } else {
      campaigns.push({ slug, revision, state: "refused", reason: found.reason });
    }
  }
  return { campaigns, normalise, refs, refused: campaigns.length - normalise };
}
