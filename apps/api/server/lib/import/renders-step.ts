import { ObjectExistsError, type ObjectStorePort } from "@campaignfoundry/CampaignOrchestration";
import { contentTypeFor, renderObjectKey } from "@campaignfoundry/Distribution";
import { errorMessage } from "@campaignfoundry/shared";
import { hashBytes } from "../brief-files.js";
import { renderPrefix } from "../object-store/object-keys.js";
import { reportRenderPaths } from "./report-paths.js";
import type { Reviewed } from "./rows-step.js";
import type { MintedObject, RowEntry } from "./steps.js";

/** The object-store calls a render import makes: all a store has to offer it. */
export type RenderObjects = Pick<ObjectStorePort, "put" | "get" | "head">;

/** The campaign a render belongs to: its org, its uuid (the key) and its slug (the path's first segment). */
export interface RenderCampaign {
  readonly orgId: string;
  readonly campaignId: string;
  readonly slug: string;
}

/** Reads one render's source file for the import: not there, its reviewed bytes, or refused. */
export type RenderReader = (path: string) => Promise<Reviewed>;

/**
 * What one render path came to (PT-8d; D221, D223). `written`: this run created
 * the object. `skipped`: the same bytes were already stored. `present`: no source
 * file, and an object is already at the key (a render made after the switch).
 * `missing`: no source file and no object. `refused`: nothing was written, and
 * `reason` says why. `failed`: the store or the reader threw, so whether an
 * object was written is not known. `key` is absent only when none could be built.
 */
export type RenderResult =
  | {
      readonly path: string;
      readonly status: "written" | "skipped" | "present" | "missing";
      readonly key: string;
    }
  | {
      readonly path: string;
      readonly status: "refused" | "failed";
      readonly key?: string;
      readonly reason: string;
    };

/** The key was taken: the same bytes stored is `skipped`, anything else `refused`. Never a write. */
async function compareStored(
  objects: RenderObjects,
  key: string,
  path: string,
  bytes: Buffer,
): Promise<RenderResult> {
  const stored = await objects.get(key);
  if (stored === undefined) {
    const reason = "an object was at this key for the write and is gone for the read";
    return { path, status: "refused", key, reason };
  }
  if (hashBytes(Buffer.from(stored.bytes)) === hashBytes(bytes)) {
    return { path, status: "skipped", key };
  }
  const reason = "a different render is already stored for this path";
  return { path, status: "refused", key, reason };
}

/**
 * Import ONE render a report names (PT-8d; D221, D223). The key is the one the app
 * reads the render with (`renderObjectKey` over `renderPrefix`), so a path outside
 * this campaign, or with no known content type, is refused before the file is read.
 * The write is an exclusive create (`ifNoneMatch: "*"`): an object already at the
 * key is compared by SHA-256 and never overwritten. It NEVER throws: a store or a
 * reader that throws is the render `failed`, so the caller keeps what it wrote.
 */
export async function importRender(
  objects: RenderObjects,
  campaign: RenderCampaign,
  path: string,
  read: RenderReader,
): Promise<RenderResult> {
  let key: string;
  let contentType: string;
  try {
    key = renderObjectKey(renderPrefix(campaign.orgId, campaign.campaignId), campaign.slug, path);
    contentType = contentTypeFor(path);
  } catch (error) {
    return { path, status: "refused", reason: errorMessage(error) };
  }
  try {
    const source = await read(path);
    if (source.state === "refused") {
      return { path, status: "refused", key, reason: source.reason };
    }
    if (source.state === "absent") {
      const stored = await objects.head(key);
      return { path, status: stored === undefined ? "missing" : "present", key };
    }
    try {
      await objects.put(key, source.bytes, { contentType, ifNoneMatch: "*" });
    } catch (error) {
      if (!(error instanceof ObjectExistsError)) throw error;
      return await compareStored(objects, key, path, source.bytes);
    }
    return { path, status: "written", key };
  } catch (error) {
    return { path, status: "failed", key, reason: errorMessage(error) };
  }
}

/**
 * Import one campaign's renders: each DISTINCT path once (one proof is named by
 * many rows of a report), in first-seen order. It stops at the first `failed`
 * render, as `importRows` stops at a failed row. `record` is told each object
 * this call CREATED and is awaited BEFORE the next render is tried (Grok PT-8d
 * 6): a crash between two writes leaves no created object without a record.
 * The import itself never throws. A `record` that throws is NOT caught: a
 * record that cannot be kept must stop the run before the next write.
 */
export async function importRenders(
  objects: RenderObjects,
  campaign: RenderCampaign,
  paths: readonly string[],
  read: RenderReader,
  record?: MintRecord,
): Promise<RenderResult[]> {
  const results: RenderResult[] = [];
  for (const path of new Set(paths)) {
    const result = await importRender(objects, campaign, path, read);
    results.push(result);
    if (result.status === "written") await record?.({ key: result.key, path: result.path });
    if (result.status === "failed") break;
  }
  return results;
}

/**
 * The objects this import CREATED, for the result file (D229): the `written`
 * renders only. A `failed` write is not listed: its object may have been there
 * before the run, and a rollback deletes exactly the keys that are listed.
 */
export function mintedRenders(
  results: readonly RenderResult[],
): { readonly key: string; readonly path: string }[] {
  return results.flatMap((result) =>
    result.status === "written" ? [{ key: result.key, path: result.path }] : [],
  );
}

/**
 * Keeps the record of ONE object this run created (D229; Grok PT-8d 6). It
 * resolves only when the record is durable. A rollback deletes exactly the
 * recorded keys.
 */
export type MintRecord = (object: MintedObject) => Promise<void>;

/**
 * The render paths a report file names, from its reviewed bytes: the one walk
 * `plan` uses (`reportRenderPaths`), each distinct path once, in first-seen
 * order. Bytes that are not JSON name none (the rows step refuses such a file).
 */
export function reportPaths(bytes: Buffer): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return [];
  }
  return [...new Set(reportRenderPaths(parsed).map((found) => found.path))];
}

/**
 * The renders of a campaign whose report row this run neither wrote nor
 * skipped (Grok PT-8d 4): none is written, and each distinct path is listed
 * `refused` with a reason that starts "not written:". `plan` lists the same
 * paths with the same reason in the future tense (`renders-plan.ts`).
 */
export function notWrittenRenders(slug: string, paths: readonly string[]): RenderResult[] {
  const reason = `not written: this run neither wrote nor skipped the report for ${slug}`;
  return [...new Set(paths)].map((path): RenderResult => ({ path, status: "refused", reason }));
}

/** What the render import needs to know of one campaign and of its report. */
export interface CampaignRenders {
  readonly orgId: string;
  readonly slug: string;
  /** What THIS run did with the campaign's report row. */
  readonly reportStatus: RowEntry["status"];
  /** The campaign's report file, read as the reviewed one (`readReviewed`). */
  readonly reportFile: Reviewed;
  /** The campaign's uuid in the target; `undefined` when the target does not hold the campaign. */
  readonly campaignId: () => Promise<string | undefined>;
}

/**
 * Import the renders one campaign's report names (PT-8d4; Grok PT-8d 4 and 6).
 * Renders are written ONLY when this run wrote or skipped the report row: the
 * stored report is then the reviewed file, and the paths are that file's. With
 * a refused or failed row every path is listed as not written.
 *
 * It throws only BEFORE the first write (the report file is no longer the
 * reviewed one although its row was kept; the target does not hold the
 * campaign; the lookup failed) or when `record` throws. After a write, a
 * failure is a `failed` render in the answer, never a throw.
 */
export async function importCampaignRenders(
  objects: RenderObjects,
  input: CampaignRenders,
  read: RenderReader,
  record: MintRecord,
): Promise<RenderResult[]> {
  const { slug } = input;
  const kept = input.reportStatus === "written" || input.reportStatus === "skipped";
  if (input.reportFile.state !== "ok") {
    if (!kept) return [];
    throw new Error(
      `reports/${slug}.json is no longer the reviewed file; none of its renders was written`,
    );
  }
  const paths = reportPaths(input.reportFile.bytes);
  if (!kept) return notWrittenRenders(slug, paths);
  if (paths.length === 0) return [];
  const campaignId = await input.campaignId();
  if (campaignId === undefined) {
    throw new Error(`the target holds no campaign ${slug}; none of its renders was written`);
  }
  return importRenders(objects, { orgId: input.orgId, campaignId, slug }, paths, read, record);
}
