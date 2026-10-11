import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObjectStorePort } from "@campaignfoundry/CampaignOrchestration";
import { renderObjectKey } from "@campaignfoundry/Distribution";
import { dumpBrief, errorMessage } from "@campaignfoundry/shared";
import { hashBytes } from "../brief-files.js";
import type { AssetStorePort } from "../ports/asset-store.port.js";
import type { BriefStorePort } from "../ports/brief-store.port.js";
import type { DecisionStorePort } from "../ports/decision-store.port.js";
import type { PoolStorePort } from "../ports/pool-store.port.js";
import type { ReportStorePort } from "../ports/report-store.port.js";
import { renderPrefix } from "../object-store/object-keys.js";
import type { ReplanResult } from "./apply.js";
import { candidateAt, type RefTarget } from "./asset-step.js";
import { preflight } from "./campaign-step.js";
import type { PlanRefusal, ReportFieldPlan } from "./plan.js";
import { MAX_RENDER_BYTES, renderFingerprints, statReviewedRender } from "./render-file.js";
import { rewriteBriefRefs } from "./ref-rewrite.js";
import { dryRowStores, predictRows, type RowSource } from "./rows-step.js";
import type { ScannedCampaign } from "./scan.js";
import type { StepContext } from "./steps.js";

/**
 * PT-8f, the read-only checks of `verify`: campaigns, their input assets, their
 * report, pool and decisions rows and their render objects, each compared with
 * the source tree. Every function here READS: no row, no object and no file is
 * written, and the tests assert it. A mismatch is a result, never a throw. A store
 * or a file that cannot be read at all throws, with ONE exception: a store that
 * throws while a ROW is read makes that row a mismatch (`predictRows` answers it
 * as `failed`), and the rows after it are not checked.
 */

/** The kinds of thing verify compares, in the order it reports them. */
export const VERIFY_ENTITIES = [
  "campaign",
  "asset",
  "report",
  "pool",
  "decisions",
  "render",
] as const;
export type VerifyEntity = (typeof VERIFY_ENTITIES)[number];

/** One comparison of the target with the source. */
export interface VerifyCheck {
  readonly entity: VerifyEntity;
  readonly slug: string;
  /** Assets: the ref the source brief carried. Renders: the path the report names. */
  readonly item?: string;
  /**
   * `expected`: the import leaves this out by a rule the plan already lists
   * (PT-8f 2 and 9). It is listed, and it is never counted and never a mismatch.
   */
  readonly status: "match" | "mismatch" | "expected";
  readonly reason?: string;
  /** Assets only: the id the stored bytes were read by. */
  readonly id?: string;
}

/** How many of one kind verify compared, and how many matched. `expected` checks are in neither. */
export interface VerifyCount {
  readonly checked: number;
  readonly matched: number;
}

export interface VerifyReport {
  readonly checks: readonly VerifyCheck[];
  readonly counts: Readonly<Record<VerifyEntity, VerifyCount>>;
  /** True only when no check is a mismatch. */
  readonly ok: boolean;
}

/** The reads verify makes: all a store has to offer it. */
export interface VerifyStores {
  readonly briefs: Pick<BriefStorePort, "campaignMeta" | "findBriefById">;
  readonly assets: Pick<AssetStorePort, "listAssets" | "readAssetById">;
  readonly reports: Pick<ReportStorePort, "getRevision">;
  readonly pools: Pick<PoolStorePort, "readPool">;
  readonly decisions: Pick<DecisionStorePort, "readDecisions">;
  readonly objects: Pick<ObjectStorePort, "get">;
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
/** A source file that is no longer the reviewed one: always a mismatch (PT-8f 9). */
const CHANGED = /( changed since the digest| is not in the reviewed digest)$/;

/** The source file one row is imported from, as the plan's refusal list names it. */
function rowFile(source: RowSource, kind: "report" | "pool" | "decisions", slug: string): string {
  if (kind === "pool") return join(source.projectRoot, "briefs", slug, "pools.json");
  const folder = kind === "report" ? "reports" : "decisions";
  return join(source.outputRoot, folder, `${slug}.json`);
}

/**
 * One campaign's report, pool and decisions rows against the source. It runs the
 * prediction `plan` shows (`predictRows`) over stores that cannot write
 * (`dryRowStores`): a row predicted `skip` is stored under the revision the source
 * has, which is a match. `write` means the target does not hold it, and `failed`
 * that the store threw: both are mismatches. A row the import REFUSES is
 * `expected` when the plan's refusal list (`refusals`) already names that row's
 * file, and so are decisions left unwritten because their report is such a row
 * (PT-8f 9); a file changed since the digest, and every other refusal, is a mismatch.
 */
export async function verifyRows(
  stores: Pick<VerifyStores, "reports" | "pools" | "decisions">,
  source: RowSource,
  slug: string,
  refusals: readonly PlanRefusal[],
): Promise<VerifyCheck[]> {
  const dry = dryRowStores(stores.reports, stores.pools, stores.decisions);
  const rows = await predictRows(dry, source, slug);
  // A refusal that carries a `field` is about ONE render path: the row is still imported.
  const whole = refusals.filter((refusal) => refusal.field === undefined);
  const listed = new Set(whole.map((refusal) => refusal.sourcePath));
  let reportExpected = false;
  return rows.map((row): VerifyCheck => {
    const entity = row.kind;
    if (row.predicted === "skip") return { entity, slug, status: "match" };
    const reason = row.reason ?? NOT_STORED;
    const byRule =
      row.predicted === "refuse" &&
      !CHANGED.test(reason) &&
      (listed.has(rowFile(source, entity, slug)) || (entity === "decisions" && reportExpected));
    if (byRule && entity === "report") reportExpected = true;
    return { entity, slug, status: byRule ? "expected" : "mismatch", reason };
  });
}

/** The campaign a render object belongs to: its uuid (the key) and its slug (the path's first segment). */
export interface VerifyRenderCampaign {
  readonly campaignId: string;
  readonly slug: string;
}

/**
 * One render path of the reviewed report against its object. `expected` when the
 * import does not write it: the plan refused the path (an old-shape
 * `<productId>/…` path, a file that is not there, an extension with no content
 * type), no key can be built for it, or the file is over the render cap.
 * Otherwise the object is read WHOLE and its bytes are hashed against the source
 * file's (PT-8f 7's rule for assets: the check is the hash of the bytes read,
 * never a size). A source file that is not the reviewed one is a mismatch.
 */
async function verifyRender(
  objects: VerifyStores["objects"],
  ctx: Pick<StepContext, "orgId" | "outputRoot">,
  campaign: VerifyRenderCampaign,
  field: ReportFieldPlan,
  fingerprints: ReadonlyMap<string, string>,
  maxBytes: number,
): Promise<VerifyCheck> {
  const render = (status: VerifyCheck["status"], reason?: string): VerifyCheck => ({
    entity: "render",
    slug: campaign.slug,
    item: field.path,
    status,
    ...(reason === undefined ? {} : { reason }),
  });
  if (field.status === "refused") return render("expected", `not written: ${field.reason}`);
  let key: string;
  try {
    const prefix = renderPrefix(ctx.orgId, campaign.campaignId);
    key = renderObjectKey(prefix, campaign.slug, field.path);
  } catch (error) {
    return render("expected", `not written: ${errorMessage(error)}`);
  }
  const everySize = { maxBytes: Number.MAX_SAFE_INTEGER };
  const file = await statReviewedRender(ctx.outputRoot, field.path, fingerprints, everySize);
  if (file.state === "absent") return render("expected", "not written: no source file");
  if (file.state === "refused") return render("mismatch", file.reason);
  if (file.size > maxBytes) {
    return render("expected", `not written: ${file.size} bytes is over the render cap`);
  }
  const bytes = await readFile(file.file);
  const stored = await objects.get(key);
  if (stored === undefined) return render("mismatch", `no object is stored at ${key}`);
  if (hashBytes(Buffer.from(stored.bytes)) === hashBytes(bytes)) return render("match");
  return render("mismatch", `the object at ${key} differs from the source file`);
}
/**
 * One campaign's render objects against the files its reviewed report names:
 * each DISTINCT path once, in the plan's order (`fields` is the plan's own list
 * for the report, `reportRenderPaths` judged). `maxBytes` is the import's cap.
 */
export async function verifyRenders(
  objects: VerifyStores["objects"],
  ctx: Pick<StepContext, "orgId" | "outputRoot">,
  campaign: VerifyRenderCampaign,
  fields: readonly ReportFieldPlan[],
  fingerprints: ReadonlyMap<string, string>,
  maxBytes: number = MAX_RENDER_BYTES,
): Promise<VerifyCheck[]> {
  const checks: VerifyCheck[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.path)) continue;
    seen.add(field.path);
    checks.push(await verifyRender(objects, ctx, campaign, field, fingerprints, maxBytes));
  }
  return checks;
}

/**
 * Every check, counted per kind (PT-8f 6): the plan's items only, never the
 * org's rows. An `expected` check is listed and is in neither number.
 */
export function summarise(checks: readonly VerifyCheck[]): VerifyReport {
  const counts = Object.fromEntries(
    VERIFY_ENTITIES.map((entity) => {
      const own = checks.filter((check) => check.entity === entity && check.status !== "expected");
      const matched = own.filter((check) => check.status === "match").length;
      return [entity, { checked: own.length, matched }];
    }),
  ) as Record<VerifyEntity, VerifyCount>;
  return { checks, counts, ok: checks.every((check) => check.status !== "mismatch") };
}

/**
 * Verify every planned campaign, in plan order, against `plan`: the re-plan of the
 * source (`replan`). As in `apply`, a campaign that is not the imported one gets
 * no rows (F3): its rows are not checked, so they are not counted either. Renders
 * follow the report row (PT-8d 4): they are checked only when the stored report
 * IS the reviewed file's.
 */
export async function verifyImport(
  stores: VerifyStores,
  ctx: StepContext,
  plan: ReplanResult,
): Promise<VerifyReport> {
  const checks: VerifyCheck[] = [];
  const expected = plan.expectedHashes;
  const source = {
    projectRoot: ctx.projectRoot,
    outputRoot: ctx.outputRoot,
    expectedHashes: expected,
  };
  const fingerprints = renderFingerprints(plan.files);
  for (const scanned of plan.result.campaigns) {
    const slug = scanned.slug;
    const found = await verifyCampaign(stores, ctx, scanned, expected);
    checks.push(...found);
    if (found[0]!.status !== "match") continue;
    const rows = await verifyRows(stores, source, slug, plan.assembled.refusals);
    checks.push(...rows);
    if (!rows.some((row) => row.entity === "report" && row.status === "match")) continue;
    const campaignId = (await stores.briefs.campaignMeta(slug))!.campaignId;
    const fields = plan.assembled.reports.find((report) => report.slug === slug)!.fields;
    const campaign = { campaignId, slug };
    checks.push(...(await verifyRenders(stores.objects, ctx, campaign, fields, fingerprints)));
  }
  return summarise(checks);
}
