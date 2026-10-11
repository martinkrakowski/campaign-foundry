import { ObjectExistsError, type ObjectStorePort } from "@campaignfoundry/CampaignOrchestration";
import { contentTypeFor, renderObjectKey } from "@campaignfoundry/Distribution";
import { errorMessage } from "@campaignfoundry/shared";
import { hashBytes } from "../brief-files.js";
import { renderPrefix } from "../object-store/object-keys.js";
import type { Reviewed } from "./rows-step.js";

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
 * render, as `importRows` stops at a failed row, and never throws.
 */
export async function importRenders(
  objects: RenderObjects,
  campaign: RenderCampaign,
  paths: readonly string[],
  read: RenderReader,
): Promise<RenderResult[]> {
  const results: RenderResult[] = [];
  for (const path of new Set(paths)) {
    const result = await importRender(objects, campaign, path, read);
    results.push(result);
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
