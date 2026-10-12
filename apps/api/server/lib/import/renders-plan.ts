import type { ObjectStorePort } from "@campaignfoundry/CampaignOrchestration";
import { contentTypeFor, renderObjectKey } from "@campaignfoundry/Distribution";
import { errorMessage } from "@campaignfoundry/shared";
import { objectStoreClient } from "../object-store/index.js";
import { renderPrefix } from "../object-store/object-keys.js";
import { getBriefStore } from "../ports/index.js";
import type { PlanProbe } from "./apply.js";
import type { DigestFile } from "./digest.js";
import { importTenant } from "./import-tenant.js";
import type { ReportPlan } from "./plan.js";
import { renderFingerprints, statReviewedRender, type RenderFileState } from "./render-file.js";
import type { StepContext } from "./steps.js";

/** All a store has to offer the prediction: `head`. It has no way to download an object. */
export type RenderHead = Pick<ObjectStorePort, "head">;

/** What the import may do with one render's source file, without reading it. */
export type RenderStat = (path: string) => Promise<RenderFileState>;

/** The campaign whose renders are predicted; `campaignId` is undefined while the target does not hold it. */
export interface PredictedCampaign {
  readonly orgId: string;
  readonly slug: string;
  readonly campaignId: string | undefined;
}

/**
 * A render as `plan` shows it: what `apply` WOULD do with it (PT-8d). `write`:
 * the file is the reviewed one and no object is at its key. `already-there`: an
 * object of the file's size is at the key; whether the bytes are the same is
 * compared at `apply`, not here. `refuse`: `apply` would not write it, and
 * `reason` says why. `present`: no source file, an object is at the key.
 * `missing`: neither. `path-refused`: no key can be built for the path.
 * `failed` is not a prediction: a read threw, so nothing is said about this
 * render or the ones after it. `key` is absent when none could be built, and
 * while the target does not hold the campaign.
 */
export interface PlannedRender {
  readonly path: string;
  readonly predicted:
    | "write"
    | "already-there"
    | "refuse"
    | "present"
    | "missing"
    | "path-refused"
    | "failed";
  readonly key?: string;
  readonly reason?: string;
}

/** Stands in for the uuid of a campaign the target does not hold yet: only to check the path. Never shown. */
const NO_CAMPAIGN_YET = "00000000-0000-4000-8000-000000000000";
const OTHER_SIZE = "a render of another size is already stored for this path";

/**
 * Predict ONE render for `plan` (PT-8d): `head` and the reviewed file's size,
 * never a body. The key and the content type are checked exactly as
 * `importRender` checks them, before the file is looked at. For a campaign the
 * target does not hold yet nothing can be stored: the store is not asked and no
 * key is shown. It NEVER throws: a store or a file check that throws is `failed`.
 */
export async function predictRender(
  objects: RenderHead,
  campaign: PredictedCampaign,
  path: string,
  stat: RenderStat,
): Promise<PlannedRender> {
  let key: string;
  try {
    const prefix = renderPrefix(campaign.orgId, campaign.campaignId ?? NO_CAMPAIGN_YET);
    key = renderObjectKey(prefix, campaign.slug, path);
    contentTypeFor(path);
  } catch (error) {
    return { path, predicted: "path-refused", reason: errorMessage(error) };
  }
  const shown = campaign.campaignId === undefined ? {} : { key };
  try {
    const source = await stat(path);
    if (source.state === "refused") {
      return { path, predicted: "refuse", ...shown, reason: source.reason };
    }
    const stored = campaign.campaignId === undefined ? undefined : await objects.head(key);
    if (source.state === "absent") {
      return { path, predicted: stored === undefined ? "missing" : "present", ...shown };
    }
    if (stored === undefined) return { path, predicted: "write", ...shown };
    if (stored.size === source.size) return { path, predicted: "already-there", ...shown };
    const sizes = `stored ${stored.size} bytes, the file ${source.size} bytes`;
    return { path, predicted: "refuse", ...shown, reason: `${OTHER_SIZE} (${sizes})` };
  } catch (error) {
    return { path, predicted: "failed", ...shown, reason: errorMessage(error) };
  }
}

/**
 * Predict one campaign's renders: each DISTINCT path once, in first-seen order.
 * `campaignId` looks the campaign up in the target (undefined: not there yet);
 * it is asked once, and not at all when there is no path. A lookup that throws
 * is the first render `failed`. It stops at the first `failed`, as
 * `importRenders` stops at a failed write, and never throws.
 */
export async function predictRenders(
  objects: RenderHead,
  campaign: { readonly orgId: string; readonly slug: string },
  campaignId: () => Promise<string | undefined>,
  paths: readonly string[],
  stat: RenderStat,
): Promise<PlannedRender[]> {
  const distinct = [...new Set(paths)];
  if (distinct.length === 0) return [];
  let id: string | undefined;
  try {
    id = await campaignId();
  } catch (error) {
    return [{ path: distinct[0]!, predicted: "failed", reason: errorMessage(error) }];
  }
  const results: PlannedRender[] = [];
  for (const path of distinct) {
    const result = await predictRender(objects, { ...campaign, campaignId: id }, path, stat);
    results.push(result);
    if (result.predicted === "failed") break;
  }
  return results;
}

/**
 * The renders of a campaign whose report row this run would neither write nor
 * skip (PT-8d): `apply` writes none of them, so each distinct path is listed
 * `refuse`. With no path (a campaign with no report) the list is empty.
 */
export function rendersNotWritten(slug: string, paths: readonly string[]): PlannedRender[] {
  const reason = `not written: this run would neither write nor skip the report for ${slug}`;
  return [...new Set(paths)].map((path): PlannedRender => ({ path, predicted: "refuse", reason }));
}

/** A `plan` probe with the prediction for each render the campaign's report names. */
export type RenderProbe = PlanProbe & { readonly renders?: readonly PlannedRender[] };

/**
 * Add `renders` to each of `plan`'s probes (PT-8d): what `apply` would do with
 * every render path the campaign's report names. Read from the target and from
 * `lstat` AFTER the digest was computed, so never part of it; nothing is
 * written and no object is downloaded. A `refused` probe gets no `renders`: a
 * refused campaign gets no later step in `apply`. `reports` and `files` are the
 * plan's own (`assemblePlan`, `digestSourceFiles`).
 */
export async function planRenderProbes(
  ctx: StepContext,
  probes: readonly PlanProbe[],
  reports: readonly ReportPlan[],
  files: readonly DigestFile[],
): Promise<RenderProbe[]> {
  const briefs = getBriefStore(importTenant(ctx.orgId));
  const objects = objectStoreClient();
  const stamps = renderFingerprints(files);
  const stat: RenderStat = (path) => statReviewedRender(ctx.outputRoot, path, stamps);
  const out: RenderProbe[] = [];
  for (const probe of probes) {
    if (probe.state === "refused") {
      out.push(probe);
      continue;
    }
    const { slug } = probe;
    const paths = reports
      .filter((report) => report.slug === slug)
      .flatMap((report) => report.fields.map((field) => field.path));
    // Renders are written only when this run wrote or skipped the report row.
    const report = probe.rows?.find((row) => row.kind === "report")?.predicted;
    const reportKept = report === "write" || report === "skip";
    const lookup = async (): Promise<string | undefined> =>
      (await briefs.campaignMeta(slug))?.campaignId;
    const renders = reportKept
      ? await predictRenders(objects, { orgId: ctx.orgId, slug }, lookup, paths, stat)
      : rendersNotWritten(slug, paths);
    out.push({ ...probe, renders });
  }
  return out;
}
