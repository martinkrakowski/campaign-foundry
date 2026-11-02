import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { relative } from "node:path";
import { dumpBrief, errorMessage } from "@campaignfoundry/shared";
import { renderObjectKey } from "@campaignfoundry/Distribution";
import type { ObjectKey } from "@campaignfoundry/CampaignOrchestration";
import { resolveConfined } from "../confined-path.js";
import { parseBriefText } from "../load-brief.js";
import { objectStoreClient } from "../object-store/index.js";
import { renderPrefix } from "../object-store/object-keys.js";
import { renderTarget } from "../object-store/render-target.js";
import { isAssetId } from "../ports/asset-store.port.js";
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
import { importTenant, IMPORT_ACTOR } from "./import-tenant.js";
import { normaliseCampaign, type NormaliseDeps, type NormaliseResult } from "./normalise-step.js";
import { parentsAreReal } from "./census.js";
import { classifyRefs } from "./classify.js";
import { fingerprint } from "./digest.js";
import { MAX_RENDER_BYTES, readReviewedRender, type RenderFileOptions } from "./render-file.js";
import {
  importRenders,
  mintedRenders,
  reportPaths,
  type RenderObjects,
  type RenderResult,
} from "./renders-step.js";
import type { Reviewed } from "./rows-step.js";
import type { MintedObject, StepContext } from "./steps.js";
import type { MintRecorder } from "./apply.js";

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
 * before `apply` opens `--result` or writes any row or object. Campaigns whose slugs
 * are in `excludeSlugs` (e.g. source campaigns being imported) are skipped so they
 * reach the per-campaign step instead of class-(P) normalisation.
 */
export async function replanExisting(
  db: SqlQuery,
  ctx: StepContext,
  excludeSlugs?: ReadonlySet<string>,
): Promise<ExistingReplan> {
  const items: ExistingReplanItem[] = [];
  const digested: DigestedCampaign[] = [];
  for (const row of await latestBodies(db, ctx.orgId)) {
    if (excludeSlugs?.has(row.slug)) continue;
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
  return rows[0]!.drafts;
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

/* ---------------------------------------------------------------------------
 * PT-8e3b: the stored-report render half (D223 sets b/c) and the out-of-scope
 * listing. A stored `report` row names renders by path; sets (b) and (c) are
 * the only ones this lane WRITES, and everything else is listed, never written.
 * ------------------------------------------------------------------------- */

/** Which of D223's enumerable sets a stored report row belongs to. */
export type ExistingRenderScope = "normalised" | "no-upload" | "out-of-scope";

/** One scoped existing-campaign render line (sets b and c), as the result file records it. */
export interface ExistingRenderEntry {
  readonly slug: string;
  readonly scope: Exclude<ExistingRenderScope, "out-of-scope">;
  readonly partial?: boolean;
  readonly minted: readonly MintedObject[];
  readonly renders: readonly RenderResult[];
  readonly stepError?: string;
}

/** One out-of-scope render line (listed, never written, D223). */
export interface OutOfScopeRender {
  readonly slug: string;
  readonly path: string;
  readonly key?: string;
  readonly reason: string;
}

/** The apply-side callbacks the render half reports through. */
export interface ExistingRenderCallbacks {
  readonly onMinted: MintRecorder;
  readonly onEntry: (entry: ExistingRenderEntry) => Promise<void>;
  readonly onOutOfScope: (item: OutOfScopeRender) => Promise<void>;
}

/** Tally returned by {@link applyExistingRenders}. */
export interface ExistingRendersCounts {
  readonly objectsMinted: number;
  readonly partial: boolean;
  readonly outOfScope: number;
}

const OUT_OF_SCOPE_REASON =
  "out of scope: report belongs to a campaign outside this run's write set";

/** The render statuses that make a scoped entry partial (Grok PT-8d 5). */
const UNCLEAN_RENDER = new Set<RenderResult["status"]>(["missing", "refused", "failed"]);

/** What {@link storedCampaignState} answers for one live campaign row. */
interface StoredCampaignState {
  readonly createdAtMs: number;
  readonly hasAsset: boolean;
  readonly version?: number;
  readonly actor?: string;
  readonly body?: string;
}

/**
 * One live campaign of `orgId`, as D223's scope classification reads it: its
 * creation time, whether it holds an `asset` row, and its LATEST `brief_version`
 * (version, actor, body). `undefined` when the org holds no live campaign row
 * for the slug — a stored report can outlive its campaign, and `renderTarget`
 * answers `undefined` for a deleted one the same way.
 */
async function storedCampaignState(
  db: SqlQuery,
  orgId: string,
  slug: string,
): Promise<StoredCampaignState | undefined> {
  const { rows } = await db.query<{
    created_at: string;
    has_asset: boolean;
    version: number | null;
    actor: string | null;
    body: string | null;
  }>(
    `select c.created_at,
            exists (select 1 from asset a where a.org_id = $1 and a.campaign_id = c.id) as has_asset,
            bv.version,
            bv.actor,
            bv.body
       from campaign c
       left join lateral (
         select bv2.version, bv2.actor, bv2.body
           from brief_version bv2
          where bv2.campaign_id = c.id
          order by bv2.version desc
          limit 1
       ) bv on true
      where c.org_id = $1 and c.slug = $2 and c.deleted_at is null`,
    [orgId, slug],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    createdAtMs: new Date(row.created_at).getTime(),
    hasAsset: row.has_asset,
    ...(row.version === null ? {} : { version: row.version }),
    ...(row.actor === null ? {} : { actor: row.actor }),
    ...(row.body === null ? {} : { body: row.body }),
  };
}

/**
 * Whether the stored body of a campaign's latest version names NO path ref
 * (D223): it re-parses the stored body the way `classifyExisting` does and runs
 * `classifyRefs`, and requires every non-`isAssetId` ref count to be zero. Any
 * parse failure counts as *not* zero, so nothing is imported on a body that
 * cannot be read.
 */
function hasZeroPathRefs(ctx: StepContext, slug: string, body: string | undefined): boolean {
  if (body === undefined) return false;
  try {
    const brief = parseBriefText(`${slug}.yaml`, dumpBrief(JSON.parse(body) as object));
    const refs = classifyRefs(ctx, {
      slug,
      sourcePath: "",
      name: null,
      type: null,
      brief,
      refs: [],
      sample: false,
    }).filter((ref) => !isAssetId(ref.ref));
    return refs.length === 0;
  } catch {
    return false;
  }
}

/**
 * D223's scope rule for one stored report row. Set (b): the slug was normalised
 * this run, or its latest `brief_version` is `> 1` with the import actor and zero
 * path refs. Set (c): live, parses with zero path refs, no `asset` row, and
 * `created_at` before `--switched-at` (strict `<`). Everything else is out of scope.
 */
function classifyRenderScope(
  ctx: StepContext,
  slug: string,
  state: StoredCampaignState | undefined,
  normalisedSlugs: ReadonlySet<string>,
): ExistingRenderScope {
  if (normalisedSlugs.has(slug)) return "normalised";
  if (state === undefined) return "out-of-scope";
  const zeroRefs = hasZeroPathRefs(ctx, slug, state.body);
  if (state.version !== undefined && state.version > 1 && state.actor === IMPORT_ACTOR) {
    if (zeroRefs) return "normalised";
  }
  if (!zeroRefs) return "out-of-scope";
  if (!state.hasAsset && state.createdAtMs < ctx.switchedAt.getTime()) return "no-upload";
  return "out-of-scope";
}

/**
 * Stamp one `<outputRoot>/<path>` render (sets b/c) for {@link readOutputRender}:
 * the render is confined, never through a symlink, a regular file, not over the
 * cap, and stamped with its `fingerprint` — THEN `readReviewedRender` opens it
 * with `O_NOFOLLOW` and re-checks the stamp after the read (PT-8d). A file that
 * is absent (`ENOENT`), refused or unstampable contributes no entry, so
 * `readReviewedRender` answers `absent`/`refused` exactly as it does for a
 * digest-stamped render of a source-scanned campaign.
 */
async function stampOutputRender(
  outputRoot: string,
  path: string,
  options?: RenderFileOptions,
): Promise<Map<string, string>> {
  const stamps = new Map<string, string>();
  let file: string;
  try {
    file = resolveConfined(outputRoot, path);
  } catch {
    return stamps;
  }
  const rel = relative(outputRoot, file);
  let st: Stats;
  try {
    st = await lstat(file);
  } catch {
    return stamps;
  }
  const parents = await parentsAreReal(outputRoot, rel);
  if (parents !== undefined) return stamps;
  if (st.isSymbolicLink()) return stamps;
  if (!st.isFile()) return stamps;
  const maxBytes = options?.maxBytes ?? MAX_RENDER_BYTES;
  if (st.size > maxBytes) return stamps;
  stamps.set(rel, fingerprint(st));
  return stamps;
}

/** Read one set-(b)/(c) render through {@link readReviewedRender}, stamped just now. */
async function readOutputRender(
  outputRoot: string,
  path: string,
  options?: RenderFileOptions,
): Promise<Reviewed> {
  const stamps = await stampOutputRender(outputRoot, path, options);
  return readReviewedRender(outputRoot, path, stamps, options);
}

/** Whether a source file still exists at `<outputRoot>/<path>` (confined). */
async function hasRenderSourceOnDisk(outputRoot: string, path: string): Promise<boolean> {
  let file: string;
  try {
    file = resolveConfined(outputRoot, path);
  } catch {
    return false;
  }
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function campaignUuidAnyState(
  db: SqlQuery,
  orgId: string,
  slug: string,
): Promise<string | undefined> {
  // No `deleted_at is null` filter ON PURPOSE: a stored report can outlive its
  // campaign row (report.campaign_id has no campaign FK), and D223's out-of-scope
  // listing needs the campaign uuid to build the key even for a tombstoned one.
  const { rows } = await db.query<{ id: string }>(
    `select id from campaign where org_id = $1 and slug = $2`,
    [orgId, slug],
  );
  return rows[0]?.id;
}

function renderKeyFor(
  orgId: string,
  campaignId: string,
  slug: string,
  path: string,
): ObjectKey | undefined {
  // No contentTypeFor here: an unknown extension says nothing about whether an
  // object exists at the key, and D223's listing must not depend on it.
  try {
    return renderObjectKey(renderPrefix(orgId, campaignId), slug, path);
  } catch {
    return undefined;
  }
}

async function checkOutOfScopePath(
  objects: RenderObjects,
  outputRoot: string,
  orgId: string,
  slug: string,
  path: string,
  campaignId: string | undefined,
): Promise<OutOfScopeRender | undefined> {
  if (!(await hasRenderSourceOnDisk(outputRoot, path))) return undefined;
  if (campaignId === undefined) return undefined;
  const key = renderKeyFor(orgId, campaignId, slug, path);
  if (key === undefined) return undefined;
  if ((await objects.head(key)) !== undefined) return undefined;
  return { slug, path, key, reason: OUT_OF_SCOPE_REASON };
}

/**
 * Import ONE scoped (set b/c) report's renders. A non-JSON-object body is a
 * `partial` entry with nothing written; a campaign `renderTarget` cannot resolve
 * fails the entry with a `stepError`; otherwise `importRenders` writes each
 * distinct path (recording every minted object via `onMinted` BEFORE the next
 * write) and an unclean render (`missing`/`refused`/`failed`) marks the entry
 * partial.
 */
async function importScopedReportRenders(
  objects: RenderObjects,
  ctx: StepContext,
  slug: string,
  scope: Exclude<ExistingRenderScope, "out-of-scope">,
  body: string,
  onMinted: MintRecorder,
  options?: RenderFileOptions,
): Promise<ExistingRenderEntry> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return {
      slug,
      scope,
      partial: true,
      minted: [],
      renders: [],
      stepError: `the stored report body for ${slug} is not JSON (${errorMessage(error)})`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      slug,
      scope,
      partial: true,
      minted: [],
      renders: [],
      stepError: `the stored report body for ${slug} is not a JSON object`,
    };
  }
  const paths = reportPaths(Buffer.from(body, "utf8"));
  const target = await renderTarget({ tenant: importTenant(ctx.orgId) }, slug);
  if (target === undefined) {
    return {
      slug,
      scope,
      partial: true,
      minted: [],
      renders: [],
      stepError: `the target holds no campaign ${slug}; none of its renders was written`,
    };
  }
  const results = await importRenders(
    objects,
    { orgId: ctx.orgId, campaignId: target.campaignId, slug },
    paths,
    (path) => readOutputRender(ctx.outputRoot, path, options),
    async (object) => {
      await onMinted(slug, object);
    },
  );
  const partial = results.some((result) => UNCLEAN_RENDER.has(result.status));
  return { slug, scope, partial, minted: mintedRenders(results), renders: results };
}

/**
 * Process every stored `report` row of `ctx.orgId` not already handled in set (a)
 * (`importedSlugs`), importing renders for sets (b) and (c) and listing (never writing)
 * out-of-scope report paths whose source file still exists on disk and whose S3
 * object `objects.head` confirms is absent (D223).
 */
export async function applyExistingRenders(
  db: SqlQuery,
  objects: RenderObjects | undefined,
  ctx: StepContext,
  importedSlugs: ReadonlySet<string>,
  normalisedSlugs: ReadonlySet<string>,
  callbacks: ExistingRenderCallbacks,
  options?: RenderFileOptions,
): Promise<ExistingRendersCounts> {
  const store = objects ?? objectStoreClient();
  const { rows } = await db.query<{ slug: string; body: string }>(
    `select campaign_id as slug, body from report where org_id = $1 order by campaign_id`,
    [ctx.orgId],
  );
  let objectsMinted = 0;
  let partial = false;
  let outOfScope = 0;
  for (const report of rows) {
    if (importedSlugs.has(report.slug)) continue;
    const state = await storedCampaignState(db, ctx.orgId, report.slug);
    const scope = classifyRenderScope(ctx, report.slug, state, normalisedSlugs);
    if (scope === "out-of-scope") {
      const paths = reportPaths(Buffer.from(report.body, "utf8"));
      const campaignId =
        paths.length > 0 ? await campaignUuidAnyState(db, ctx.orgId, report.slug) : undefined;
      for (const path of paths) {
        const listed = await checkOutOfScopePath(
          store,
          ctx.outputRoot,
          ctx.orgId,
          report.slug,
          path,
          campaignId,
        );
        if (listed !== undefined) {
          outOfScope++;
          await callbacks.onOutOfScope(listed);
        }
      }
      continue;
    }
    const entry = await importScopedReportRenders(
      store,
      ctx,
      report.slug,
      scope,
      report.body,
      callbacks.onMinted,
      options,
    );
    objectsMinted += entry.minted.length;
    if (entry.partial === true) partial = true;
    if (entry.renders.length > 0 || entry.stepError !== undefined) {
      await callbacks.onEntry(entry);
    }
  }
  return { objectsMinted, partial, outOfScope };
}
