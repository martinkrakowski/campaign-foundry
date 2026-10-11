import { dumpBrief } from "@campaignfoundry/shared";
import { hashBytes } from "../brief-files.js";
import type { AssetStorePort } from "../ports/asset-store.port.js";
import type { BriefStorePort } from "../ports/brief-store.port.js";
import type { DecisionStorePort } from "../ports/decision-store.port.js";
import type { PoolStorePort } from "../ports/pool-store.port.js";
import type { ReportStorePort } from "../ports/report-store.port.js";
import { candidateAt, type RefTarget } from "./asset-step.js";
import { preflight } from "./campaign-step.js";
import { rewriteBriefRefs } from "./ref-rewrite.js";
import { dryRowStores, predictRows, type RowSource } from "./rows-step.js";
import type { ScannedCampaign } from "./scan.js";
import type { StepContext } from "./steps.js";

/**
 * PT-8f, the read-only checks of `verify` that need only what is imported today:
 * campaigns, their input assets, and their report, pool and decisions rows, each
 * compared with the source tree. Every function here READS: no row, no object and
 * no file is written, and the tests assert it. A mismatch is a result, never a
 * throw; a store or a file that cannot be read at all still throws.
 */

/** The kinds of thing verify compares, in the order it reports them. */
export const VERIFY_ENTITIES = ["campaign", "asset", "report", "pool", "decisions"] as const;
export type VerifyEntity = (typeof VERIFY_ENTITIES)[number];

/** One comparison of the target with the source. */
export interface VerifyCheck {
  readonly entity: VerifyEntity;
  readonly slug: string;
  /** Assets only: the ref the source brief carried. */
  readonly item?: string;
  readonly status: "match" | "mismatch";
  readonly reason?: string;
  /** Assets only: the id the stored bytes were read by. */
  readonly id?: string;
}

/** How many of one kind verify compared, and how many matched. */
export interface VerifyCount {
  readonly checked: number;
  readonly matched: number;
}

export interface VerifyReport {
  readonly checks: readonly VerifyCheck[];
  readonly counts: Readonly<Record<VerifyEntity, VerifyCount>>;
  /** True only when every check matched. */
  readonly ok: boolean;
}

/** The reads verify makes: all a store has to offer it. */
export interface VerifyStores {
  readonly briefs: Pick<BriefStorePort, "campaignMeta" | "findBriefById">;
  readonly assets: Pick<AssetStorePort, "listAssets" | "readAssetById">;
  readonly reports: Pick<ReportStorePort, "getRevision">;
  readonly pools: Pick<PoolStorePort, "readPool">;
  readonly decisions: Pick<DecisionStorePort, "readDecisions">;
}
/**
 * One ref target against the campaign's stored assets. The import stored it under
 * the first free name of `candidateAt` (D219), so the same names are walked here;
 * each is read BY ID and its bytes hashed (no port exposes `asset.sha256`, PT-8-5).
 * A name whose bytes differ belongs to another file: the walk goes on, and ends at
 * the first name the campaign does not hold.
 */
async function verifyAsset(
  assets: VerifyStores["assets"],
  byName: ReadonlyMap<string, string>,
  slug: string,
  target: RefTarget,
  bytes: Buffer,
): Promise<VerifyCheck> {
  const mismatch = (reason: string, id?: string): VerifyCheck => ({
    entity: "asset",
    slug,
    item: target.ref,
    status: "mismatch",
    reason,
    ...(id === undefined ? {} : { id }),
  });
  const sourceSha = hashBytes(bytes);
  const tried: string[] = [];
  for (let index = 0; ; index++) {
    const candidate = candidateAt(target.name, target.from, index);
    const id = byName.get(candidate);
    if (id === undefined) {
      return mismatch(
        tried.length === 0
          ? `no asset named ${candidate} is stored for ${slug}`
          : `the stored bytes differ from the source file (${tried.join(", ")})`,
      );
    }
    const stored = await assets.readAssetById(id);
    if (stored === undefined) {
      return mismatch(`asset ${candidate} (${id}) has a row but its bytes cannot be read`, id);
    }
    if (hashBytes(stored) === sourceSha) {
      return { entity: "asset", slug, item: target.ref, status: "match", id };
    }
    tried.push(candidate);
  }
}
/**
 * One planned campaign against the target: the campaign's check first, then one
 * check per ref target. The source is read through `preflight`, so a file that is
 * not the reviewed one is a mismatch and nothing is compared with it. The campaign
 * matches only when every asset matched AND the source brief, rewritten with
 * exactly the ids those assets were read by, equals the stored latest version.
 */
export async function verifyCampaign(
  stores: Pick<VerifyStores, "briefs" | "assets">,
  ctx: StepContext,
  scanned: ScannedCampaign,
  expected: ReadonlyMap<string, string>,
): Promise<VerifyCheck[]> {
  const slug = scanned.slug;
  const campaign = (reason?: string): VerifyCheck =>
    reason === undefined
      ? { entity: "campaign", slug, status: "match" }
      : { entity: "campaign", slug, status: "mismatch", reason };
  const pf = await preflight(ctx, scanned, expected);
  if (!pf.ok) return [campaign(`the source cannot be compared: ${pf.reason}`)];
  const meta = await stores.briefs.campaignMeta(slug);
  if (meta === undefined) return [campaign("no campaign row in the target")];
  if (!meta.hasVersion) return [campaign("the campaign has no saved version")];
  const entries = await stores.assets.listAssets(slug);
  const byName = new Map<string, string>(entries.map((entry) => [entry.name, entry.id as string]));
  const checks: VerifyCheck[] = [];
  const refToId = new Map<string, string>();
  for (const target of pf.preflight.targets) {
    const bytes = pf.preflight.targetBytes.get(target.ref)!;
    const check = await verifyAsset(stores.assets, byName, slug, target, bytes);
    checks.push(check);
    if (check.status === "match") refToId.set(target.ref, check.id!);
  }
  const failed = checks.filter((check) => check.status === "mismatch").length;
  if (failed > 0) return [campaign(`${failed} of its assets do not match`), ...checks];
  const stored = await stores.briefs.findBriefById(slug);
  if (stored === undefined) return [campaign("the latest version cannot be read"), ...checks];
  const rewritten = rewriteBriefRefs(pf.preflight.brief, slug, refToId);
  if (dumpBrief(rewritten) !== dumpBrief(stored.brief)) {
    return [campaign("the stored brief differs from the rewritten source"), ...checks];
  }
  return [campaign(), ...checks];
}
const NOT_STORED = "not stored in the target";

/**
 * One campaign's report, pool and decisions rows against the source. It runs the
 * prediction `plan` shows (`predictRows`) over stores that cannot write
 * (`dryRowStores`): a row predicted `skip` is stored under the revision the source
 * has, which is a match. `write` means the target does not hold it; `refuse` and
 * `failed` carry their own reason.
 */
export async function verifyRows(
  stores: Pick<VerifyStores, "reports" | "pools" | "decisions">,
  source: RowSource,
  slug: string,
): Promise<VerifyCheck[]> {
  const dry = dryRowStores(stores.reports, stores.pools, stores.decisions);
  const rows = await predictRows(dry, source, slug);
  return rows.map(
    (row): VerifyCheck =>
      row.predicted === "skip"
        ? { entity: row.kind, slug, status: "match" }
        : { entity: row.kind, slug, status: "mismatch", reason: row.reason ?? NOT_STORED },
  );
}

/** Every check, counted per kind. */
export function summarise(checks: readonly VerifyCheck[]): VerifyReport {
  const counts = Object.fromEntries(
    VERIFY_ENTITIES.map((entity) => {
      const own = checks.filter((check) => check.entity === entity);
      const matched = own.filter((check) => check.status === "match").length;
      return [entity, { checked: own.length, matched }];
    }),
  ) as Record<VerifyEntity, VerifyCount>;
  return { checks, counts, ok: checks.every((check) => check.status === "match") };
}

/**
 * Verify every planned campaign, in plan order. As in `apply`, a campaign that is
 * not the imported one gets no rows (F3): its rows are not checked, so they are
 * not counted either. The campaign's own mismatch already makes the report not ok.
 */
export async function verifyImport(
  stores: VerifyStores,
  ctx: StepContext,
  campaigns: readonly ScannedCampaign[],
  expected: ReadonlyMap<string, string>,
): Promise<VerifyReport> {
  const checks: VerifyCheck[] = [];
  const source = {
    projectRoot: ctx.projectRoot,
    outputRoot: ctx.outputRoot,
    expectedHashes: expected,
  };
  for (const scanned of campaigns) {
    const found = await verifyCampaign(stores, ctx, scanned, expected);
    checks.push(...found);
    if (found[0]!.status !== "match") continue;
    checks.push(...(await verifyRows(stores, source, scanned.slug)));
  }
  return summarise(checks);
}
