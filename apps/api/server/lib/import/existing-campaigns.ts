import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CampaignBrief } from "@campaignfoundry/CampaignOrchestration";
import { dumpBrief, errorMessage } from "@campaignfoundry/shared";
import type { SqlQuery } from "../db/sql-client.js";
import { parseBriefText } from "../load-brief.js";
import { isAssetId } from "../ports/asset-store.port.js";
import { hashBytes } from "../brief-files.js";
import { resolveRefTargets } from "./asset-step.js";
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

/** The org's row counts (Q0, PT-8e 7): a staging `plan` run is the measurement. */
export interface ExistingCounts {
  readonly campaigns: number;
  readonly briefVersions: number;
  readonly reports: number;
  readonly assets: number;
}

/**
 * How many rows the org has in `campaign`, `brief_version`, `report` and `asset`. These
 * are ROW counts: a tombstoned campaign and its versions are counted. One `select`.
 */
export async function existingCounts(db: SqlQuery, orgId: string): Promise<ExistingCounts> {
  const { rows } = await db.query<{
    campaigns: number;
    brief_versions: number;
    reports: number;
    assets: number;
  }>(
    `select
       (select count(*)::int from campaign where org_id = $1) as campaigns,
       (select count(*)::int from brief_version bv
          join campaign c on c.id = bv.campaign_id where c.org_id = $1) as brief_versions,
       (select count(*)::int from report where org_id = $1) as reports,
       (select count(*)::int from asset where org_id = $1) as assets`,
    [orgId],
  );
  const row = rows[0]!;
  return {
    campaigns: row.campaigns,
    briefVersions: row.brief_versions,
    reports: row.reports,
    assets: row.assets,
  };
}

/**
 * The number of unsaved drafts per campaign of the org, by campaign uuid (PT-8e 8). A
 * campaign with no draft is not in the map. A new brief version makes a draft's
 * `base_revision` stale, and the resume route then deletes that draft.
 */
export async function draftCounts(
  db: SqlQuery,
  orgId: string,
): Promise<ReadonlyMap<string, number>> {
  const { rows } = await db.query<{ campaign_id: string; drafts: number }>(
    `select campaign_id, count(*)::int as drafts from draft where org_id = $1 group by campaign_id`,
    [orgId],
  );
  return new Map(rows.map((row) => [row.campaign_id, row.drafts]));
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

/** One ref target as the second digest saw it: the ref the body names, and its file's sha256. */
export interface ExistingFile {
  readonly ref: string;
  readonly sha256: string;
}

/** What the second digest covers of one `normalise` campaign. */
export interface DigestedCampaign {
  readonly slug: string;
  readonly revision: string;
  readonly files: readonly ExistingFile[];
}

/**
 * The sha256 of each file a `normalise` campaign's path refs name, in the body's own
 * ref order. Each file is read once, here. Every ref is clean (`classifyExisting`), so
 * each resolves under `assets/` to a regular file. A file that vanished since then
 * throws, and `plan` ends with that error: nothing is hashed by guessing.
 */
export function refTargetHashes(
  ctx: StepContext,
  found: Extract<ExistingCampaign, { readonly state: "normalise" }>,
): ExistingFile[] {
  const targets = resolveRefTargets(ctx, {
    slug: found.slug,
    sourcePath: "",
    name: null,
    type: null,
    brief: found.brief,
    refs: found.refs,
    sample: false,
  });
  return targets.map((target) => ({
    ref: target.ref,
    sha256: hashBytes(readFileSync(target.path)),
  }));
}

/**
 * The second digest (PT-8e 1): what the owner reviewed of class (P), which `apply`
 * recomputes and refuses on before the first normalise write. The sha256, in hex, of
 * the UTF-8 bytes of `JSON.stringify` of `[slug, revision, [[ref, sha256], …]]` per
 * campaign: campaigns by slug (code-unit order; a slug is unique in an org), each
 * campaign's files in the order given (the body's ref order). No campaign is `[]`.
 */
export function existingDigest(campaigns: readonly DigestedCampaign[]): string {
  const sorted = [...campaigns].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const canonical = JSON.stringify(
    sorted.map((c) => [c.slug, c.revision, c.files.map((file) => [file.ref, file.sha256])]),
  );
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** One campaign of the plan's `existingCampaigns` section. */
export type ExistingCampaignPlan =
  | {
      readonly slug: string;
      readonly revision: string;
      readonly state: "normalise";
      readonly refs: readonly RefClassification[];
      /** The campaign's unsaved drafts (PT-8e 8); `apply` skips a campaign that has one. */
      readonly drafts: number;
      /** Each path ref with its file's sha256, as the section's `digest` covers them. */
      readonly files: readonly ExistingFile[];
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
  /** How many `normalise` campaigns have at least one draft. */
  readonly withDraft: number;
  readonly counts: ExistingCounts;
  /** The second digest (PT-8e 1): see {@link existingDigest}. */
  readonly digest: string;
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
  let withDraft = 0;
  const digested: DigestedCampaign[] = [];
  const drafts = await draftCounts(db, ctx.orgId);
  for (const row of await latestBodies(db, ctx.orgId)) {
    const found = classifyExisting(ctx, row);
    if (found === undefined) continue;
    const { slug, revision } = found;
    if (found.state === "normalise") {
      normalise++;
      refs += found.refs.length;
      const draftCount = drafts.get(found.campaignId) ?? 0;
      if (draftCount > 0) withDraft++;
      const files = refTargetHashes(ctx, found);
      digested.push({ slug, revision, files });
      campaigns.push({
        slug,
        revision,
        state: "normalise",
        refs: found.refs,
        drafts: draftCount,
        files,
      });
    } else {
      campaigns.push({ slug, revision, state: "refused", reason: found.reason });
    }
  }
  const counts = await existingCounts(db, ctx.orgId);
  return {
    campaigns,
    normalise,
    refs,
    refused: campaigns.length - normalise,
    withDraft,
    counts,
    digest: existingDigest(digested),
  };
}
